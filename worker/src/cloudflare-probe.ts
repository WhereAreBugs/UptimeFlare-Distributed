import { DEFAULT_MONITOR_TIMEOUT_MS } from '../../util/monitor-settings'
import { claimScheduledMonitors, completeScheduledClaim, releaseScheduledClaim } from './scheduling'
import pLimit from 'p-limit'
import type { MonitorTarget } from '../../types/config'
import type { ProbeResult } from '../../types/probes'
import type { Env } from './index'
import { doMonitor } from './monitor'
import { parseNativeDiagnostic } from './diagnostics'
import { persistBatch } from './probes'
import { CLOUDFLARE_PROBE_ID, saveProbeLabel } from './probe-labels'

/** Uses the same D1 transaction, idempotency and history as external probes. */
export async function runCloudflareProbe(
  env: Env,
  monitors: MonitorTarget[],
  time: number,
  location: string | (() => Promise<string>),
  check: typeof doMonitor = doMonitor
) {
  const assigned = monitors
    .filter((m) => m.probes?.includes(CLOUDFLARE_PROBE_ID))
    .map((monitor) => ({
      ...monitor,
      timeout: monitor.timeout ?? DEFAULT_MONITOR_TIMEOUT_MS,
      checkProxy: undefined,
      checkProxyFallback: undefined,
    }))
  const claim = await claimScheduledMonitors(
    env,
    'cloudflare',
    assigned,
    time,
    Math.floor(Date.now() / 1000)
  )
  if (!claim.monitors.length) return
  try {
    const checkLocation = typeof location === 'string' ? location : await location()
    // The location is a Cloudflare colo code; scheduled Workers have no fixed host IP.
    const colo = /^[A-Z]{3}$/.test(checkLocation) ? checkLocation : ''
    try {
      await saveProbeLabel(
        env,
        CLOUDFLARE_PROBE_ID,
        `Cloudflare${colo ? ` ${colo}` : ''} · AS13335`,
        colo ? `Cloudflare edge ${colo}` : 'Cloudflare edge'
      )
    } catch {
      console.error('Cloudflare probe label update failed')
    }
    const limit = pLimit(5)
    const results: ProbeResult[] = await Promise.all(
      claim.monitors.map((monitor) =>
        limit(async () => {
          // A built-in Cloudflare assignment always checks directly, even if a legacy
          // source config still contains proxy options.
          const { status } = await check(
            { ...monitor, checkProxy: undefined, checkProxyFallback: undefined },
            checkLocation,
            env
          )
          const failure = status.up ? undefined : parseNativeDiagnostic(status.err)
          return {
            monitor_id: monitor.id,
            time,
            up: status.up,
            latency_ms: status.ping,
            ...(failure && {
              stage: failure.stage === 'proxy' ? 'unknown' : failure.stage,
              code: failure.code,
              message: failure.message,
            }),
          }
        })
      )
    )
    await persistBatch(env, CLOUDFLARE_PROBE_ID, results, [completeScheduledClaim(env, claim)], {
      scope: claim.scope,
      key: claim.key,
    })
  } catch (error) {
    await releaseScheduledClaim(env, claim).catch(() => undefined)
    throw error
  }
}
