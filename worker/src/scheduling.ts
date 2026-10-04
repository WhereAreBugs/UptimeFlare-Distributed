import type { MonitorTarget } from '../../types/config'
import type { ProbeEnv } from './probes'
import {
  DEFAULT_MONITOR_TIMEOUT_MS,
  getMonitorIntervalSeconds,
  MIN_MONITOR_INTERVAL_SECONDS,
  MAX_MONITOR_INTERVAL_SECONDS,
} from '../../util/monitor-settings'

export type ScheduledClaim = { monitors: MonitorTarget[]; scope: string; key: string; time: number }
type ScheduleRow = {
  monitor_id: string
  configuration_key: string
  last_started_at: number
  last_completed_at: number
  lease_until: number
}

/** Only check-affecting options invalidate a target's schedule; labels and webhooks do not. */
async function scheduleInputs(monitors: MonitorTarget[]) {
  return Promise.all(
    monitors.map(async (monitor) => {
      const interval = getMonitorIntervalSeconds(monitor)
      if (
        (monitor.intervalSeconds !== undefined && !Number.isInteger(monitor.intervalSeconds)) ||
        !Number.isInteger(interval) ||
        interval < MIN_MONITOR_INTERVAL_SECONDS ||
        interval > MAX_MONITOR_INTERVAL_SECONDS ||
        (monitor.timeout !== undefined &&
          (!Number.isInteger(monitor.timeout) || monitor.timeout < 1 || monitor.timeout > 120000))
      )
        throw new Error('Invalid monitor interval or timeout')
      const configuration = JSON.stringify({
        method: monitor.method,
        target: monitor.target,
        interval,
        timeout: monitor.timeout ?? DEFAULT_MONITOR_TIMEOUT_MS,
        headers: Object.entries(monitor.headers ?? {}).sort(([a], [b]) => a.localeCompare(b)),
        body: monitor.body,
        expectedCodes: monitor.expectedCodes?.slice().sort((a, b) => a - b),
        responseKeyword: monitor.responseKeyword,
        responseForbiddenKeyword: monitor.responseForbiddenKeyword,
        checkProxy: monitor.checkProxy,
        checkProxyFallback: monitor.checkProxyFallback,
        checkProxyHeaders: Object.entries(monitor.checkProxyHeaders ?? {}).sort(([a],[b]) => a.localeCompare(b)),
        icmpProxyURL: monitor.icmpProxyURL,
        certificateExpiryDays: monitor.certificateExpiryDays,
      })
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(configuration))
      const fingerprint = Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, '0')
      ).join('')
      return { id: monitor.id, fingerprint, interval }
    })
  )
}

export async function hasDueMonitors(
  env: ProbeEnv,
  scope: string,
  monitors: MonitorTarget[],
  time: number,
  now = time
) {
  if (!monitors.length) return false
  const inputs = await scheduleInputs(monitors)
  const rows = await env.UPTIMEFLARE_D1.prepare(
    "SELECT monitor_id,configuration_key,last_started_at,last_completed_at,lease_until FROM monitor_schedule WHERE scope=? AND monitor_id IN (SELECT json_extract(value,'$.id') FROM json_each(?))"
  )
    .bind(scope, JSON.stringify(inputs))
    .all<ScheduleRow>()
  if (!rows.success) throw new Error('Monitor schedule read failed')
  const schedules = new Map(rows.results.map((row) => [row.monitor_id, row]))
  return inputs.some((input) => {
    const previous = schedules.get(input.id)
    return (
      !previous ||
      (previous.last_started_at < time &&
        previous.lease_until <= now &&
        (previous.configuration_key !== input.fingerprint ||
          previous.last_completed_at === 0 ||
          previous.last_completed_at + input.interval <= time))
    )
  })
}

/** Atomic leases prevent duplicate or overlapping Cron checks. Results and completion share a transaction. */
export async function claimScheduledMonitors(
  env: ProbeEnv,
  scope: string,
  monitors: MonitorTarget[],
  time: number,
  now = time
): Promise<ScheduledClaim> {
  const key = crypto.randomUUID()
  if (!monitors.length) return { monitors: [], scope, key, time }
  const inputs = await scheduleInputs(monitors)
  // Scheduled Workers have a 15 minute lifetime. A dead invocation can be reclaimed
  // after this bounded lease; the token fences any unexpectedly late completion.
  const leaseSeconds = Math.min(
    900,
    Math.max(
      120,
      Math.ceil(Math.max(...monitors.map((m) => m.timeout ?? DEFAULT_MONITOR_TIMEOUT_MS)) / 1000) *
        Math.ceil(monitors.length / 5) +
        60
    )
  )
  const claimed = await env.UPTIMEFLARE_D1.prepare(
    `INSERT INTO monitor_schedule
    (scope,monitor_id,configuration_key,last_started_at,last_completed_at,lease_until,lease_key)
    SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.fingerprint'),?,0,?,? FROM json_each(?) WHERE 1
    ON CONFLICT(scope,monitor_id) DO UPDATE SET configuration_key=excluded.configuration_key,
      last_started_at=excluded.last_started_at,lease_until=excluded.lease_until,lease_key=excluded.lease_key
    WHERE monitor_schedule.last_started_at < excluded.last_started_at AND monitor_schedule.lease_until <= ? AND
      (monitor_schedule.configuration_key <> excluded.configuration_key OR monitor_schedule.last_completed_at=0 OR
       monitor_schedule.last_completed_at + (SELECT json_extract(value,'$.interval') FROM json_each(?) WHERE json_extract(value,'$.id')=monitor_schedule.monitor_id) <= excluded.last_started_at)
    RETURNING monitor_id`
  )
    .bind(scope, time, now + leaseSeconds, key, JSON.stringify(inputs), now, JSON.stringify(inputs))
    .all<{ monitor_id: string }>()
  if (!claimed.success) throw new Error('Monitor schedule claim failed')
  const ids = new Set(claimed.results.map((row) => row.monitor_id))
  return { monitors: monitors.filter((monitor) => ids.has(monitor.id)), scope, key, time }
}

export function completeScheduledClaim(
  env: ProbeEnv,
  claim: ScheduledClaim,
  nativeWriter?: string
): D1PreparedStatement {
  return env.UPTIMEFLARE_D1.prepare(
    `UPDATE monitor_schedule SET last_completed_at=?,lease_until=0,lease_key='' WHERE scope=? AND lease_key=?${
      nativeWriter
        ? " AND EXISTS (SELECT 1 FROM monitor_schedule writer WHERE writer.scope='native-writer' AND writer.monitor_id='state' AND writer.lease_key=?)"
        : ''
    }`
  ).bind(claim.time, claim.scope, claim.key, ...(nativeWriter ? [nativeWriter] : []))
}
export async function releaseScheduledClaim(env: ProbeEnv, claim: ScheduledClaim) {
  await env.UPTIMEFLARE_D1.prepare(
    "UPDATE monitor_schedule SET lease_until=0,lease_key='' WHERE scope=? AND lease_key=?"
  )
    .bind(claim.scope, claim.key)
    .run()
}

/** Legacy compacted state is one document, so its writers need one shared lease. */
export async function claimNativeWriter(
  env: ProbeEnv,
  time: number,
  now = time
): Promise<string | null> {
  const key = crypto.randomUUID()
  const row = await env.UPTIMEFLARE_D1.prepare(
    `INSERT INTO monitor_schedule
    (scope,monitor_id,configuration_key,last_started_at,last_completed_at,lease_until,lease_key)
    VALUES ('native-writer','state','',?,0,?,?) ON CONFLICT(scope,monitor_id) DO UPDATE SET
    last_started_at=excluded.last_started_at,lease_until=excluded.lease_until,lease_key=excluded.lease_key
    WHERE monitor_schedule.last_started_at < excluded.last_started_at AND monitor_schedule.lease_until <= ? RETURNING lease_key`
  )
    .bind(time, now + 900, key, now)
    .first<{ lease_key: string }>()
  return row?.lease_key ?? null
}
export function releaseNativeWriterStatement(env: ProbeEnv, key: string): D1PreparedStatement {
  return env.UPTIMEFLARE_D1.prepare(
    "UPDATE monitor_schedule SET lease_until=0,lease_key='' WHERE scope='native-writer' AND monitor_id='state' AND lease_key=?"
  ).bind(key)
}

export async function cleanupMonitorSchedules(env: ProbeEnv, monitors: MonitorTarget[]) {
  await env.UPTIMEFLARE_D1.prepare(
    `DELETE FROM monitor_schedule WHERE (scope,monitor_id) IN
    (SELECT scope,monitor_id FROM monitor_schedule WHERE scope<>'native-writer' AND monitor_id NOT IN (SELECT value FROM json_each(?)) LIMIT 1000)`
  )
    .bind(JSON.stringify(monitors.map((monitor) => monitor.id)))
    .run()
}
