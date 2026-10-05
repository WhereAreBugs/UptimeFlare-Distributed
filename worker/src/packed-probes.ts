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
import { prepareProbeAggregates } from './probe-aggregates'

export const MAX_BLOCK_BYTES = 32 * 1024,
  MAX_BLOCK_SAMPLES = 200,
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
  const config = await getRuntimeConfig(env, fallbackConfig, false)
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
    if (normalized.length) {
      statements.push(...(await prepareProbeAggregates(env, probeId, normalized, guard)))
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
    templates = new Set(config.notificationTemplates?.map((template) => template.id)),
    candidates = config.monitors.filter(
      (monitor) =>
        !monitor.paused &&
        templates.has(monitor.notificationTemplateId ?? '') &&
        results.some(
          (result) =>
            result.monitor_id === monitor.id &&
            result.time >= now - getMonitorStaleAfterSeconds(monitor)
        )
    ),
    ids = candidates.map((monitor) => monitor.id)
  // Offline history cannot trigger a current notification. Neither unrelated
  // targets nor targets without a template require a latest/observation read.
  if (!ids.length) return []
  const pairs = JSON.stringify(
    candidates.flatMap((monitor) => (monitor.probes ?? []).map((id) => [id, monitor.id]))
  )
  const rows = await env.UPTIMEFLARE_D1.prepare(
    `SELECT probe_id,monitor_id,time,up,stage,code FROM probe_latest WHERE
      (probe_id,monitor_id) IN (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?))`
  )
    .bind(pairs)
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
  for (const monitor of candidates.filter((monitor) => changed.has(monitor.id))) {
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
