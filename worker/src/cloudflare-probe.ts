import { checkMonitors } from './regional'
import { DEFAULT_MONITOR_TIMEOUT_MS } from '../../util/monitor-settings'
import {
  claimScheduledMonitors,
  completeScheduledClaim,
  releaseScheduledClaim,
  type ScheduledBudget,
} from './scheduling'
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
  check: typeof doMonitor = doMonitor,
  budget?: ScheduledBudget,
  scopeLimit?: number
) {
  const assigned = monitors
    .filter((m) => !m.paused && m.probes?.includes(CLOUDFLARE_PROBE_ID))
    .map((monitor) => ({
      ...monitor,
      timeout: monitor.timeout ?? DEFAULT_MONITOR_TIMEOUT_MS,
    }))
  const claim = await claimScheduledMonitors(
    env,
    'cloudflare',
    assigned,
    time,
    Math.floor(Date.now() / 1000),
    budget,
    scopeLimit
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
    const checked = await checkMonitors(claim.monitors, checkLocation, env, check)
    const results: ProbeResult[] = checked.map(({ id, status }) => {
      const failure = status.up ? undefined : parseNativeDiagnostic(status.err)
      return {
        monitor_id: id,
        time,
        up: status.up,
        latency_ms: status.ping,
        ...(status.certificate_expires_at !== undefined && {
          certificate_expires_at: status.certificate_expires_at,
        }),
        ...(status.certificate_days_remaining !== undefined && {
          certificate_days_remaining: status.certificate_days_remaining,
        }),
        ...(status.icmp_latency_ms !== undefined && { icmp_latency_ms: status.icmp_latency_ms }),
        ...(failure && { stage: failure.stage, code: failure.code, message: failure.message }),
      }
    })
    const measuredClaim = {
      ...claim,
      monitors: claim.monitors.filter((m) => results.some((r) => r.monitor_id === m.id)),
    }
    await releaseScheduledClaim(
      env,
      { ...claim, key: claim.key, monitors: [] },
      results.map((r) => r.monitor_id)
    )
    await persistBatch(
      env,
      CLOUDFLARE_PROBE_ID,
      results,
      [completeScheduledClaim(env, measuredClaim)],
      {
        scope: claim.scope,
        key: claim.key,
      }
    )
  } catch (error) {
    await releaseScheduledClaim(env, claim).catch(() => undefined)
    throw error
  }
}
