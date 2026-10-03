import type { WorkerConfig } from '../../types/config'
import type { Env } from './index'
import {
  DEFAULT_MONITOR_TIMEOUT_MS,
  getMonitorStaleAfterSeconds,
} from '../../util/monitor-settings'
import { doMonitor } from './monitor'
import { formatAndNotify } from './util'
import { CompactedMonitorStateWrapper, getFromStore } from './store'
import pLimit from 'p-limit'
import {
  hasDueMonitors,
  claimScheduledMonitors,
  completeScheduledClaim,
  releaseScheduledClaim,
  claimNativeWriter,
  releaseNativeWriterStatement,
  type ScheduledClaim,
} from './scheduling'

/** Native history is a compacted document: serialize its writers and persist only due targets. */
export async function runNativeMonitors(
  env: Env,
  workerConfig: WorkerConfig,
  time: number,
  location: string | (() => Promise<string>),
  check: typeof doMonitor = doMonitor
) {
  const nativeMonitors = workerConfig.monitors.filter((monitor) => !monitor.probes?.length)
  const now = Math.floor(Date.now() / 1000)
  if (!(await hasDueMonitors(env, 'native', nativeMonitors, time, now))) return
  const writer = await claimNativeWriter(env, time, now)
  if (!writer) return
  let writerReleased = false
  let claim: ScheduledClaim | undefined
  try {
    claim = await claimScheduledMonitors(env, 'native', nativeMonitors, time, now)
    if (!claim.monitors.length) return
    const workerLocation = typeof location === 'string' ? location : await location()
    console.log(`Running scheduled event on ${workerLocation}...`)

    // Create a wrapped MonitorState from stored compacted state
    const state = new CompactedMonitorStateWrapper(await getFromStore(env, 'state'))
    state.data.overallDown = 0
    state.data.overallUp = 0

    const pendingEffects: (() => Promise<void>)[] = []
    const currentTimeSecond = time

    // Parallel check multiple monitors
    // Max concurrent connection is 6 limited by Cloudflare Workers, we use 5 here to be safe
    type CheckResult = {
      id: string
      location: string
      status: { ping: number; up: boolean; err: string }
    }
    let checkQueue: Promise<CheckResult>[] = []
    let checkResult: Record<string, CheckResult> = {}
    const limit = pLimit(5)
    for (const monitor of claim.monitors) {
      checkQueue.push(
        limit(() =>
          check(
            { ...monitor, timeout: monitor.timeout ?? DEFAULT_MONITOR_TIMEOUT_MS },
            workerLocation,
            env
          )
        )
      )
    }
    for (const result of await Promise.all(checkQueue)) {
      checkResult[result.id] = result
    }

    // Update each monitor's state based on check results
    for (const monitor of claim.monitors) {
      console.log(`Processing monitor result: ${monitor.name} (${monitor.id})`)

      let monitorStatusChanged = false
      const { location: checkLocation, status } = checkResult[monitor.id]

      // Update counters
      status.up ? state.data.overallUp++ : state.data.overallDown++

      // Update incidents
      // Create a dummy incident to store the start time of the monitoring and simplify logic
      if (state.incidentLen(monitor.id) === 0) {
        state.appendIncident(monitor.id, {
          start: [currentTimeSecond],
          end: currentTimeSecond,
          error: ['dummy'],
        })
      }

      // Then lastIncident here must not be null
      let lastIncident = state.getIncident(monitor.id, state.incidentLen(monitor.id) - 1)

      if (status.up) {
        // Current status is up
        // close existing incident if any
        if (lastIncident.end === null) {
          lastIncident.end = currentTimeSecond
          // write back the modified last incident
          state.setIncident(monitor.id, state.incidentLen(monitor.id) - 1, lastIncident)

          monitorStatusChanged = true
          pendingEffects.push(async () => {
            try {
              if (
                // grace period not set OR ...
                workerConfig.notification?.gracePeriod === undefined ||
                // only when we have sent a notification for DOWN status, we will send a notification for UP status (within 30 seconds of possible drift)
                currentTimeSecond - lastIncident.start[0] >=
                  (workerConfig.notification.gracePeriod + 1) * 60 - 30
              ) {
                if (!monitor.notificationTemplateId)
                  await formatAndNotify(
                    monitor,
                    true,
                    lastIncident.start[0],
                    currentTimeSecond,
                    'OK'
                  )
              } else {
                console.log(
                  `grace period (${workerConfig.notification?.gracePeriod}m) not met, skipping webhook UP notification for ${monitor.name}`
                )
              }

              console.log('Calling config onStatusChange callback...')
              await workerConfig.callbacks?.onStatusChange?.(
                env,
                monitor,
                true,
                lastIncident.start[0],
                currentTimeSecond,
                'OK'
              )
            } catch (e) {
              console.log('Error calling callback: ')
              console.log(e)
            }
          })
        }
      } else {
        // Current status is down
        // open new incident if not already open
        if (lastIncident.end !== null) {
          state.appendIncident(monitor.id, {
            start: [currentTimeSecond],
            end: null,
            error: [status.err],
          })
          monitorStatusChanged = true
        } else if (lastIncident.end === null && lastIncident.error.slice(-1)[0] !== status.err) {
          // append if the error message changes
          lastIncident.start.push(currentTimeSecond)
          lastIncident.error.push(status.err)

          // write back the modified last incident
          state.setIncident(monitor.id, state.incidentLen(monitor.id) - 1, lastIncident)
          monitorStatusChanged = true
        }

        const currentIncident = state.getIncident(monitor.id, state.incidentLen(monitor.id) - 1)
        pendingEffects.push(async () => {
          try {
            if (
              // monitor status changed AND...
              (monitorStatusChanged &&
                // grace period not set OR ...
                (workerConfig.notification?.gracePeriod === undefined ||
                  // have sent a notification for DOWN status
                  currentTimeSecond - currentIncident.start[0] >=
                    (workerConfig.notification.gracePeriod + 1) * 60 - 30)) ||
              // grace period is set AND...
              (workerConfig.notification?.gracePeriod !== undefined &&
                // grace period is met
                currentTimeSecond - currentIncident.start[0] >=
                  workerConfig.notification.gracePeriod * 60 - 30 &&
                currentTimeSecond - currentIncident.start[0] <
                  workerConfig.notification.gracePeriod * 60 + 30)
            ) {
              if (
                currentIncident.start[0] !== currentTimeSecond &&
                workerConfig.notification?.skipErrorChangeNotification
              ) {
                console.log(
                  'Skipping notification for following error reason change due to user config'
                )
              } else {
                if (!monitor.notificationTemplateId)
                  await formatAndNotify(
                    monitor,
                    false,
                    currentIncident.start[0],
                    currentTimeSecond,
                    status.err
                  )
              }
            } else {
              console.log(
                `Grace period (${workerConfig.notification
                  ?.gracePeriod}m) not met or no change (currently down for ${
                  currentTimeSecond - currentIncident.start[0]
                }s, changed ${monitorStatusChanged}), skipping webhook DOWN notification for ${
                  monitor.name
                }`
              )
            }

            if (monitorStatusChanged) {
              console.log('Calling config onStatusChange callback...')
              await workerConfig.callbacks?.onStatusChange?.(
                env,
                monitor,
                false,
                currentIncident.start[0],
                currentTimeSecond,
                status.err
              )
            }
          } catch (e) {
            console.log('Error calling callback: ')
            console.log(e)
          }
        })

        pendingEffects.push(async () => {
          try {
            console.log('Calling config onIncident callback...')
            await workerConfig.callbacks?.onIncident?.(
              env,
              monitor,
              currentIncident.start[0],
              currentTimeSecond,
              status.err
            )
          } catch (e) {
            console.log('Error calling callback: ')
            console.log(e)
          }
        })
      }

      // append to latency data
      state.appendLatency(monitor.id, {
        loc: checkLocation,
        ping: status.ping,
        time: currentTimeSecond,
      })

      // discard old data
      while (state.getFirstLatency(monitor.id).time < currentTimeSecond - 12 * 60 * 60) {
        state.unshiftLatency(monitor.id)
      }

      // discard old incidents
      while (
        state.incidentLen(monitor.id) > 0 &&
        state.getIncident(monitor.id, 0).end &&
        state.getIncident(monitor.id, 0).end! < currentTimeSecond - 90 * 24 * 60 * 60
      ) {
        state.shiftIncident(monitor.id)
      }

      if (
        state.incidentLen(monitor.id) === 0 ||
        (state.getIncident(monitor.id, 0).start[0] > currentTimeSecond - 90 * 24 * 60 * 60 &&
          state.getIncident(monitor.id, 0).error[0] != 'dummy')
      ) {
        // put the dummy incident back
        state.unshiftIncident(monitor.id, {
          start: [currentTimeSecond - 90 * 24 * 60 * 60],
          end: currentTimeSecond - 90 * 24 * 60 * 60,
          error: ['dummy'],
        })
      }
    }

    // Only each target's own most recent check can keep its status fresh.
    state.data.overallUp = 0
    state.data.overallDown = 0
    for (const monitor of nativeMonitors) {
      if (!state.incidentLen(monitor.id) || !state.data.latency[monitor.id]?.time) continue
      const latest = state.getLastLatency(monitor.id)
      if (latest.time < time - getMonitorStaleAfterSeconds(monitor)) continue
      const incident = state.getIncident(monitor.id, state.incidentLen(monitor.id) - 1)
      incident.end === null ? state.data.overallDown++ : state.data.overallUp++
    }
    // A due target is persisted immediately; a global cooldown cannot make a
    // short-interval target falsely stale or drop its latest latency timestamp.
    state.data.lastUpdate = currentTimeSecond
    const committed = await env.UPTIMEFLARE_D1.batch([
      env.UPTIMEFLARE_D1.prepare(
        `INSERT INTO uptimeflare (key,value)
        SELECT 'state',? WHERE EXISTS (SELECT 1 FROM monitor_schedule WHERE scope='native-writer' AND monitor_id='state' AND lease_key=?)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value`
      ).bind(state.getCompactedStateStr(), writer),
      completeScheduledClaim(env, claim, writer),
      releaseNativeWriterStatement(env, writer),
    ])
    if (committed.some((result) => !result.success))
      throw new Error('Native result persistence failed')
    writerReleased = true
    if (!committed[0].meta.changes) {
      await releaseScheduledClaim(env, claim)
      return
    }
    for (const effect of pendingEffects) await effect()
  } catch (error) {
    if (claim) await releaseScheduledClaim(env, claim).catch(() => undefined)
    throw error
  } finally {
    if (!writerReleased) await releaseNativeWriterStatement(env, writer).run()
  }
}
