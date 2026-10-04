import type { ProbeEnv } from './probes'
import type { ProbeResult } from '../../types/probes'
import type { WorkerConfig } from '../../types/config'
import { beginCommit, endCommit, releaseCommit } from './commit'
import { getRuntimeConfig } from './settings'
import { workerConfig as fallbackConfig } from '../../uptime.config'
import {
  prepareNotifications,
  resetNeutralNotifications,
  type NotificationInput,
  effectiveNotificationConfig,
  suppressedMonitors,
} from './notifications'
import { getMonitorStaleAfterSeconds } from '../../util/monitor-settings'
import { publicFailure } from './privacy'

export const MAX_BLOCK_BYTES = 32 * 1024,
  MAX_BLOCK_SAMPLES = 40,
  MAX_WINDOW_CHUNKS = 128
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength
const key = (r: ProbeResult) => r.monitor_id + ':' + r.time
export function splitResultBlocks(results: ProbeResult[]) {
  const blocks: ProbeResult[][] = []
  let block: ProbeResult[] = []
  for (const result of results) {
    if (bytes([result]) > MAX_BLOCK_BYTES) throw new Error('Result exceeds block budget')
    if (
      block.length &&
      (block.length >= MAX_BLOCK_SAMPLES || bytes([...block, result]) > MAX_BLOCK_BYTES)
    ) {
      blocks.push(block)
      block = []
    }
    block.push(result)
  }
  if (block.length) blocks.push(block)
  return blocks
}
/** Persist full results in bounded probe/window blocks; hot state, rollups and events share one transaction. */
export async function persistPackedBatch(
  env: ProbeEnv,
  probeId: string,
  results: ProbeResult[],
  runId: string,
  completion: D1PreparedStatement[] = [],
  gate?: { scope: string; key: string }
) {
  const config = await getRuntimeConfig(env, fallbackConfig)
  const lease = await beginCommit(env, runId, { probeId, results }, config)
  if (lease.replay) return
  try {
    const windows = Array.from(new Set(results.map((r) => Math.floor(r.time / 300) * 300)))
    const stored = await env.UPTIMEFLARE_D1.prepare(
      'SELECT window,chunk,value FROM probe_result_blocks WHERE probe_id=? AND window IN (SELECT value FROM json_each(?)) ORDER BY window,chunk LIMIT 2049'
    )
      .bind(probeId, JSON.stringify(windows))
      .all<{ window: number; chunk: number; value: string }>()
    if (
      !stored.success ||
      stored.results.length > 2048 ||
      stored.results.reduce((sum, row) => sum + new TextEncoder().encode(row.value).byteLength, 0) >
        8 * 1024 * 1024
    )
      throw new Error('Packed history read budget exceeded')
    const seen = new Set<string>(),
      last = new Map<number, { chunk: number; value: ProbeResult[] }>()
    for (const row of stored.results) {
      const values = JSON.parse(row.value) as ProbeResult[]
      for (const value of values) seen.add(key(value))
      last.set(row.window, { chunk: row.chunk, value: values })
    }
    let fresh = results
      .filter((r) => {
        if (seen.has(key(r))) return false
        seen.add(key(r))
        return true
      })
      .map(fullResult)
    if (gate) {
      const rows = await env.UPTIMEFLARE_D1.prepare(
        'SELECT monitor_id FROM monitor_schedule WHERE scope=? AND lease_key=? AND lease_until>unixepoch()'
      )
        .bind(gate.scope, gate.key)
        .all<{ monitor_id: string }>()
      if (!rows.success) throw new Error('Schedule ownership read failed')
      const ids = new Set(rows.results.map((r) => r.monitor_id))
      fresh = fresh.filter((r) => ids.has(r.monitor_id))
    }
    // Late paused uploads are durable history, but cannot change notification/current lifecycle.
    const statements: D1PreparedStatement[] = [],
      normalized = fresh
        .filter((r) => !['proxy', 'configuration'].includes(r.stage ?? ''))
        .map((r) => ({
          ...r,
          message: r.up
            ? ''
            : publicFailure(r.stage ?? 'unknown', r.code ?? 'unknown', r.message).message,
        }))
    const guard = gate
      ? `(${lease.guard}) AND NOT EXISTS(SELECT 1 FROM json_each('${JSON.stringify(
          fresh.map((r) => r.monitor_id)
        ).replace(
          /'/g,
          "''"
        )}') e WHERE NOT EXISTS(SELECT 1 FROM monitor_schedule s WHERE s.scope='${
          gate.scope
        }' AND s.monitor_id=e.value AND s.lease_key='${gate.key}' AND s.lease_until>unixepoch()))`
      : lease.guard
    const packed: unknown[] = []
    for (const window of windows) {
      const values = fresh.filter((r) => Math.floor(r.time / 300) * 300 === window)
      if (!values.length) continue
      const previous = last.get(window),
        chunks = splitResultBlocks([...(previous?.value ?? []), ...values])
      const start = previous?.chunk ?? 0
      if (start + chunks.length > MAX_WINDOW_CHUNKS)
        throw new Error('Probe window capacity exceeded')
      for (let i = 0; i < chunks.length; i++)
        packed.push({ window, chunk: start + i, value: JSON.stringify(chunks[i]) })
    }
    if (packed.length)
      statements.push(
        env.UPTIMEFLARE_D1.prepare(
          `INSERT INTO probe_result_blocks(probe_id,window,chunk,value) SELECT ?,json_extract(value,'$.window'),json_extract(value,'$.chunk'),json_extract(value,'$.value') FROM json_each(?) WHERE (${guard}) ON CONFLICT(probe_id,window,chunk) DO UPDATE SET value=excluded.value`
        ).bind(probeId, JSON.stringify(packed))
      )
    const payload = JSON.stringify(
      normalized.map((r) => ({
        ...r,
        stage: r.stage ?? '',
        code: r.code ?? '',
        message: r.message ?? '',
        up: r.up ? 1 : 0,
      }))
    )
    const items = `SELECT json_extract(value,'$.monitor_id') monitor_id,json_extract(value,'$.time') time,json_extract(value,'$.up') up,json_extract(value,'$.latency_ms') latency_ms,json_extract(value,'$.stage') stage,json_extract(value,'$.code') code,json_extract(value,'$.message') message FROM json_each(?)`
    const aggregate = `WITH fresh AS (${items}), deltas AS (SELECT monitor_id,CAST(time/300 AS INTEGER)*300 time,COUNT(*) checks,SUM(1-up) failures,SUM(latency_ms) latency_sum FROM fresh GROUP BY monitor_id,CAST(time/300 AS INTEGER)*300)`
    if (normalized.length) {
      statements.push(
        env.UPTIMEFLARE_D1.prepare(
          `${aggregate}, days AS (SELECT d.monitor_id,CAST(d.time/86400 AS INTEGER)*86400 time,SUM(d.checks) checks,SUM(d.failures) failures,SUM(CASE WHEN COALESCE(b.failures,0)+d.failures=0 THEN COALESCE(b.checks,0)+d.checks ELSE 0 END-CASE WHEN COALESCE(b.failures,0)=0 THEN COALESCE(b.checks,0) ELSE 0 END) latency_checks,SUM(CASE WHEN COALESCE(b.failures,0)+d.failures=0 THEN COALESCE(b.latency_sum,0)+d.latency_sum ELSE 0 END-CASE WHEN COALESCE(b.failures,0)=0 THEN COALESCE(b.latency_sum,0) ELSE 0 END) latency_sum FROM deltas d LEFT JOIN probe_buckets b ON b.probe_id=? AND b.monitor_id=d.monitor_id AND b.time=d.time GROUP BY d.monitor_id,CAST(d.time/86400 AS INTEGER)*86400) INSERT INTO probe_days(probe_id,monitor_id,time,checks,failures,latency_checks,latency_sum) SELECT ?,monitor_id,time,checks,failures,latency_checks,latency_sum FROM days WHERE (${guard}) ON CONFLICT(probe_id,monitor_id,time) DO UPDATE SET checks=probe_days.checks+excluded.checks,failures=probe_days.failures+excluded.failures,latency_checks=probe_days.latency_checks+excluded.latency_checks,latency_sum=probe_days.latency_sum+excluded.latency_sum`
        ).bind(payload, probeId, probeId)
      )
      statements.push(
        env.UPTIMEFLARE_D1.prepare(
          `${aggregate} INSERT INTO probe_buckets(probe_id,monitor_id,time,checks,failures,latency_sum) SELECT ?,monitor_id,time,checks,failures,latency_sum FROM deltas WHERE (${guard}) ON CONFLICT(probe_id,monitor_id,time) DO UPDATE SET checks=probe_buckets.checks+excluded.checks,failures=probe_buckets.failures+excluded.failures,latency_sum=probe_buckets.latency_sum+excluded.latency_sum`
        ).bind(payload, probeId)
      )
      statements.push(
        env.UPTIMEFLARE_D1.prepare(
          `WITH fresh AS (${items}) INSERT INTO probe_totals(probe_id,monitor_id,checks,failures,latency_sum) SELECT ?,monitor_id,COUNT(*),SUM(1-up),SUM(latency_ms) FROM fresh WHERE (${guard}) GROUP BY monitor_id ON CONFLICT(probe_id,monitor_id) DO UPDATE SET checks=probe_totals.checks+excluded.checks,failures=probe_totals.failures+excluded.failures,latency_sum=probe_totals.latency_sum+excluded.latency_sum`
        ).bind(payload, probeId)
      )
      for (const [table, windowed] of [
        ['probe_stage_totals', false],
        ['probe_bucket_stages', true],
      ] as const)
        statements.push(
          env.UPTIMEFLARE_D1.prepare(
            `WITH fresh AS (${items}) INSERT INTO ${table}(probe_id,monitor_id,${
              windowed ? 'time,' : ''
            }stage,failures) SELECT ?,monitor_id,${
              windowed ? 'CAST(time/300 AS INTEGER)*300,' : ''
            }stage,COUNT(*) FROM fresh WHERE up=0 AND (${guard}) GROUP BY monitor_id,${
              windowed ? 'CAST(time/300 AS INTEGER)*300,' : ''
            }stage ON CONFLICT(probe_id,monitor_id,${
              windowed ? 'time,' : ''
            }stage) DO UPDATE SET failures=${table}.failures+excluded.failures`
          ).bind(payload, probeId)
        )
      statements.push(
        env.UPTIMEFLARE_D1.prepare(
          `WITH fresh AS (${items}) INSERT OR IGNORE INTO probe_failure_events(probe_id,monitor_id,time,stage,code,message) SELECT ?,monitor_id,time,stage,code,message FROM fresh WHERE up=0 AND (${guard})`
        ).bind(payload, probeId)
      )
      statements.push(
        env.UPTIMEFLARE_D1.prepare(
          `WITH fresh AS (${items}), ranked AS (SELECT *,ROW_NUMBER() OVER(PARTITION BY monitor_id ORDER BY time DESC) rank FROM fresh) INSERT INTO probe_latest(probe_id,monitor_id,time,up,latency_ms,stage,code,message) SELECT ?,monitor_id,time,up,latency_ms,stage,code,message FROM ranked WHERE rank=1 AND (${guard}) ON CONFLICT(probe_id,monitor_id) DO UPDATE SET time=excluded.time,up=excluded.up,latency_ms=excluded.latency_ms,stage=excluded.stage,code=excluded.code,message=excluded.message WHERE excluded.time>probe_latest.time`
        ).bind(payload, probeId)
      )
      const details = normalized.flatMap((r) => {
        const value = {
          ...(r.certificate_expires_at !== undefined && {
            certificateExpiresAt: r.certificate_expires_at,
          }),
          ...(r.certificate_days_remaining !== undefined && {
            certificateDaysRemaining: r.certificate_days_remaining,
          }),
          ...(r.icmp_latency_ms !== undefined && { icmpLatencyMs: r.icmp_latency_ms }),
        }
        return Object.keys(value).length
          ? [{ id: r.monitor_id, time: r.time, value: JSON.stringify(value) }]
          : []
      })
      if (details.length)
        statements.push(
          env.UPTIMEFLARE_D1.prepare(
            `INSERT OR IGNORE INTO probe_sample_details(probe_id,monitor_id,time,details) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.time'),json_extract(value,'$.value') FROM json_each(?) WHERE (${guard})`
          ).bind(probeId, JSON.stringify(details))
        )
      statements.push(...(await projectedNotifications(env, config, probeId, normalized, guard)))
    }
    // Completion supplied by trusted Cron code is additionally wrapped in the lease guard by callers.
    if (gate)
      statements.push(
        env.UPTIMEFLARE_D1.prepare(
          `UPDATE monitor_schedule SET last_completed_at=last_started_at,lease_until=0,lease_key='' WHERE scope=? AND lease_key=? AND (${guard}) AND monitor_id IN (SELECT value FROM json_each(?))`
        ).bind(gate.scope, gate.key, JSON.stringify(fresh.map((r) => r.monitor_id)))
      )
    else if (completion.length) throw new Error('Unfenced completion statements are unsupported')
    const committed = await endCommit(env, { ...lease, guard }, statements)
    if (!committed) throw new Error('Commit lease/config changed; retry the same batch')
  } finally {
    await releaseCommit(env, lease)
  }
}
async function projectedNotifications(
  env: ProbeEnv,
  source: WorkerConfig,
  probeId: string,
  results: ProbeResult[],
  guard: string
) {
  const config = effectiveNotificationConfig(source).config,
    now = Math.floor(Date.now() / 1000),
    ids = Array.from(new Set(results.map((r) => r.monitor_id)))
  const rows = await env.UPTIMEFLARE_D1.prepare(
    'SELECT probe_id,monitor_id,time,up,stage,code FROM probe_latest WHERE monitor_id IN (SELECT value FROM json_each(?))'
  )
    .bind(JSON.stringify(ids))
    .all<{
      probe_id: string
      monitor_id: string
      time: number
      up: number
      stage: string
      code: string
    }>()
  if (!rows.success) throw new Error('Notification hot read failed')
  const latest = new Map(rows.results.map((r) => [r.monitor_id + ':' + r.probe_id, r]))
  const changed = new Set<string>()
  for (const r of results) {
    const identity = r.monitor_id + ':' + probeId
    if (r.time > (latest.get(identity)?.time ?? 0)) {
      latest.set(identity, {
        probe_id: probeId,
        monitor_id: r.monitor_id,
        time: r.time,
        up: r.up ? 1 : 0,
        stage: r.stage ?? '',
        code: r.code ?? '',
      })
      changed.add(r.monitor_id)
    }
  }
  const markers = await env.UPTIMEFLARE_D1.prepare(
    'SELECT monitor_id,sample_time FROM notification_observations WHERE status IN ("paused","awaiting") AND monitor_id IN (SELECT value FROM json_each(?))'
  )
    .bind(JSON.stringify(ids))
    .all<{ monitor_id: string; sample_time: number }>()
  if (!markers.success) throw new Error('Notification resume read failed')
  const resumeAfter = new Map(markers.results.map((r) => [r.monitor_id, r.sample_time]))
  const suppressed = suppressedMonitors(config, now),
    inputs: NotificationInput[] = [],
    neutral: string[] = []
  for (const monitor of config.monitors.filter(
    (m) => changed.has(m.id) && m.notificationTemplateId && !m.paused
  )) {
    const reporting = (monitor.probes ?? [])
      .map((id) => latest.get(monitor.id + ':' + id))
      .filter(
        (r): r is NonNullable<typeof r> =>
          !!r && r.time >= now - getMonitorStaleAfterSeconds(monitor)
      )
    const resumedAt = resumeAfter.get(monitor.id)
    if (
      resumedAt !== undefined &&
      (monitor.probes ?? []).some(
        (id) => (latest.get(monitor.id + ':' + id)?.time ?? 0) <= resumedAt
      )
    )
      continue
    if (!reporting.length || (reporting.some((r) => r.up) && reporting.some((r) => !r.up))) {
      neutral.push(monitor.id)
      continue
    }
    const up = reporting.filter((r) => r.up).length,
      down = reporting.length - up
    if (up && down) continue
    const reason = reporting
      .filter((r) => !r.up)
      .map((r) => r.probe_id + ':' + r.stage + '/' + r.code)
      .sort()
      .join(';')
    inputs.push({
      monitor,
      status: down ? 'down' : 'up',
      sampleTime: Math.max(...reporting.map((r) => r.time)),
      reason,
      now,
      options: {
        graceSeconds:
          monitor.notificationGracePeriodSeconds ?? (config.notification?.gracePeriod ?? 0) * 60,
        skipReasonChanges: config.notification?.skipErrorChangeNotification ?? false,
        suppressed: suppressed.has(monitor.id),
        timeZone: config.notification?.timeZone,
        reasonKey: reason,
      },
    })
  }
  return [
    ...resetNeutralNotifications(env, neutral, now, guard),
    ...(await prepareNotifications(env, inputs, guard)),
  ]
}

/** Private durable history preserves all defined wire fields; arbitrary properties never enter storage. */
function fullResult(r: ProbeResult): ProbeResult {
  return {
    monitor_id: r.monitor_id,
    time: r.time,
    up: r.up,
    latency_ms: r.latency_ms,
    ...(r.stage !== undefined && { stage: r.stage }),
    ...(r.code !== undefined && { code: r.code }),
    ...(r.message !== undefined && { message: r.message }),
    ...(r.certificate_expires_at !== undefined && {
      certificate_expires_at: r.certificate_expires_at,
    }),
    ...(r.certificate_days_remaining !== undefined && {
      certificate_days_remaining: r.certificate_days_remaining,
    }),
    ...(r.icmp_latency_ms !== undefined && { icmp_latency_ms: r.icmp_latency_ms }),
  }
}
