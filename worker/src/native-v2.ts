import type { WorkerConfig } from '../../types/config'
import type { Env } from './index'
import type { CheckResult } from './regional'
import { beginCommit, endCommit, releaseCommit } from './commit'
import { nativeHot } from './storage-v2'
import { completeScheduledClaim, type ScheduledClaim } from './scheduling'
import {
  effectiveNotificationConfig,
  prepareNotifications,
  type NotificationInput,
  suppressedMonitors,
} from './notifications'
import { classifyNativeFailure, formatNativeDiagnostic } from './diagnostics'

/** Stable cycles read only bounded hot rows and the current five-minute latency block. */
export type NativeEffect = {
  id: string
  up: boolean
  start: number
  time: number
  error: string
  changed: boolean
}
export async function commitNativeV2(
  env: Env,
  config: WorkerConfig,
  claim: ScheduledClaim,
  results: CheckResult[],
  effects: NativeEffect[] = []
) {
  if (!results.length) return false
  const lease = await beginCommit(env, 'native:' + claim.key, { time: claim.time, results }, config)
  if (lease.replay) return true
  try {
    const ids = results.map((r) => r.id),
      prior = new Map((await nativeHot(env, ids)).map((r) => [r.monitor_id, r]))
    const window = Math.floor(claim.time / 300) * 300
    const blocks = await env.UPTIMEFLARE_D1.prepare(
      'SELECT monitor_id,value FROM native_latency_blocks WHERE monitor_id IN (SELECT value FROM json_each(?)) AND window=?'
    )
      .bind(JSON.stringify(ids), window)
      .all<{ monitor_id: string; value: string }>()
    if (!blocks.success) throw new Error('Latency block read failed')
    const priorBlocks = new Map(
      blocks.results.map((r) => [
        r.monitor_id,
        JSON.parse(r.value) as { time: number; ping: number; loc: string }[],
      ])
    )
    const statements: D1PreparedStatement[] = [],
      hot: unknown[] = [],
      episodes: unknown[] = [],
      reasons: unknown[] = [],
      latency: unknown[] = [],
      notificationInputs: NotificationInput[] = []
    const notification = effectiveNotificationConfig(config).config,
      templates = new Set(notification.notificationTemplates?.map((t) => t.id)),
      suppressed = suppressedMonitors(notification, claim.time)
    for (const result of results) {
      const before = prior.get(result.id)
      if (before && before.time >= claim.time) continue
      const error = result.status.up
        ? ''
        : formatNativeDiagnostic(classifyNativeFailure(result.status.err))
      const incidentStart = result.status.up
        ? null
        : before && !before.up
        ? before.incident_start ?? claim.time
        : claim.time

      hot.push({
        id: result.id,
        time: claim.time,
        up: result.status.up ? 1 : 0,
        ping: result.status.ping,
        location: result.location.slice(0, 200),
        error,
        incidentStart,
        firstSeen: before?.first_seen ?? claim.time,
        sequence: (before?.sequence ?? 0) + 1,
      })
      if (!result.status.up && (before?.up !== 0 || before.error !== error)) {
        episodes.push({ id: result.id, start: incidentStart, end: null })
        reasons.push({ id: result.id, start: incidentStart, time: claim.time, error })
      } else if (result.status.up && before?.up === 0 && before.incident_start !== null)
        episodes.push({ id: result.id, start: before.incident_start, end: claim.time })
      const samples = (priorBlocks.get(result.id) ?? []).filter((r) => r.time !== claim.time)
      samples.push({
        time: claim.time,
        ping: result.status.ping,
        loc: result.location.slice(0, 200),
      })
      if (samples.length > 10) throw new Error('Native window capacity exceeded')
      latency.push({ id: result.id, window, value: JSON.stringify(samples) })
      const monitor = notification.monitors.find((m) => m.id === result.id)!
      if (templates.has(monitor.notificationTemplateId ?? ''))
        notificationInputs.push({
          monitor,
          status: result.status.up ? 'up' : 'down',
          sampleTime: claim.time,
          reason: error,
          now: Math.floor(Date.now() / 1000),
          options: {
            graceSeconds:
              monitor.notificationGracePeriodSeconds ??
              (notification.notification?.gracePeriod ?? 0) * 60,
            skipReasonChanges: notification.notification?.skipErrorChangeNotification ?? false,
            suppressed: suppressed.has(monitor.id),
            timeZone: notification.notification?.timeZone,
          },
        })
    }
    const receiptGuard = `(${lease.guard}) AND NOT EXISTS(SELECT 1 FROM json_each('${JSON.stringify(
      ids
    ).replace(/'/g, "''")}') e WHERE NOT EXISTS(SELECT 1 FROM monitor_schedule s WHERE s.scope='${
      claim.scope
    }' AND s.monitor_id=e.value AND s.lease_key='${claim.key}' AND s.last_started_at=${
      claim.time
    } AND s.lease_until>unixepoch()))`
    // Each row is fenced independently. Pause/reclaim of one target cannot authorize stale state writes.
    const owned = `(${receiptGuard}) AND EXISTS(SELECT 1 FROM monitor_schedule s WHERE s.scope=? AND s.monitor_id=json_extract(e.value,'$.id') AND s.lease_key=? AND s.last_started_at=? AND s.lease_until>unixepoch())`
    statements.push(
      env.UPTIMEFLARE_D1.prepare(
        `INSERT INTO native_latency_blocks(monitor_id,window,value) SELECT json_extract(e.value,'$.id'),json_extract(e.value,'$.window'),json_extract(e.value,'$.value') FROM json_each(?) e WHERE ${owned} ON CONFLICT(monitor_id,window) DO UPDATE SET value=excluded.value`
      ).bind(JSON.stringify(latency), claim.scope, claim.key, claim.time)
    )
    statements.push(...(await prepareNotifications(env, notificationInputs, receiptGuard)))
    statements.unshift(
      env.UPTIMEFLARE_D1.prepare(
        `INSERT INTO native_hot(monitor_id,time,up,ping,location,error,incident_start,first_seen,sequence) SELECT json_extract(e.value,'$.id'),json_extract(e.value,'$.time'),json_extract(e.value,'$.up'),json_extract(e.value,'$.ping'),json_extract(e.value,'$.location'),json_extract(e.value,'$.error'),json_extract(e.value,'$.incidentStart'),json_extract(e.value,'$.firstSeen'),json_extract(e.value,'$.sequence') FROM json_each(?) e WHERE ${owned} ON CONFLICT(monitor_id) DO UPDATE SET time=excluded.time,up=excluded.up,ping=excluded.ping,location=excluded.location,error=excluded.error,incident_start=excluded.incident_start,sequence=excluded.sequence WHERE native_hot.time<excluded.time`
      ).bind(JSON.stringify(hot), claim.scope, claim.key, claim.time)
    )
    if (episodes.length)
      statements.push(
        env.UPTIMEFLARE_D1.prepare(
          `INSERT INTO native_incidents(monitor_id,start,end) SELECT json_extract(e.value,'$.id'),json_extract(e.value,'$.start'),json_extract(e.value,'$.end') FROM json_each(?) e WHERE ${owned} ON CONFLICT(monitor_id,start) DO UPDATE SET end=excluded.end`
        ).bind(JSON.stringify(episodes), claim.scope, claim.key, claim.time)
      )
    if (reasons.length)
      statements.push(
        env.UPTIMEFLARE_D1.prepare(
          `INSERT OR IGNORE INTO native_incident_reasons(monitor_id,incident_start,time,error) SELECT json_extract(e.value,'$.id'),json_extract(e.value,'$.start'),json_extract(e.value,'$.time'),json_extract(e.value,'$.error') FROM json_each(?) e WHERE ${owned}`
        ).bind(JSON.stringify(reasons), claim.scope, claim.key, claim.time)
      )
    statements.push(
      env.UPTIMEFLARE_D1.prepare(
        `UPDATE monitor_schedule SET last_completed_at=?,lease_until=0,lease_key='' WHERE scope=? AND lease_key=? AND (${receiptGuard}) AND monitor_id IN (SELECT value FROM json_each(?))`
      ).bind(claim.time, claim.scope, claim.key, JSON.stringify(ids))
    )
    const committed = await endCommit(env, { ...lease, guard: receiptGuard }, statements)
    if (committed)
      for (const result of results) {
        const before = prior.get(result.id)
        if (before && before.time >= claim.time) continue
        const error = result.status.up
          ? ''
          : formatNativeDiagnostic(classifyNativeFailure(result.status.err))
        effects.push({
          id: result.id,
          up: result.status.up,
          start: before?.incident_start ?? claim.time,
          time: claim.time,
          error,
          changed: result.status.up ? before?.up === 0 : before?.up !== 0 || before.error !== error,
        })
      }
    return committed
  } finally {
    await releaseCommit(env, lease)
  }
}
