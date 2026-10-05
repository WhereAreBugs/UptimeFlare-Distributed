import type { ProbeEnv } from './probes'
import type { ProbeResult } from '../../types/probes'
import { prepareProbeCounters, counterKey } from './probe-counters'
import { preparePackedFailures } from './packed-failures'

type Bucket = { id: string; time: number; checks: number; failures: number; sum: number }
type Day = Bucket & { latencyChecks: number; latencySum: number }
type Stage = { id: string; time: number; stage: string; failures: number }
const key = (id: string, time: number) => id + '\0' + time

/** Aggregate the bounded batch once in memory. D1 receives one delta per key,
 * rather than scanning/ranking the full JSON sample array in every statement. */
export async function prepareProbeAggregates(
  env: ProbeEnv,
  probeId: string,
  results: ProbeResult[],
  guard: string
): Promise<D1PreparedStatement[]> {
  if (!results.length) return []
  const buckets = new Map<string, Bucket>(),
    totals = new Map<string, Bucket>(),
    stages = new Map<string, Stage>(),
    latest = new Map<string, ProbeResult>(),
    details: { id: string; time: number; value: string }[] = []
  for (const result of results) {
    const window = Math.floor(result.time / 300) * 300
    for (const [map, identity] of [
      [buckets, key(result.monitor_id, window)],
      [totals, result.monitor_id],
    ] as const) {
      const delta = map.get(identity) ?? {
        id: result.monitor_id,
        time: window,
        checks: 0,
        failures: 0,
        sum: 0,
      }
      delta.checks++
      delta.failures += result.up ? 0 : 1
      delta.sum += result.latency_ms
      map.set(identity, delta)
    }
    if (!result.up) {
      for (const [map, identity] of [[stages, result.monitor_id + '\0' + result.stage]] as const) {
        const delta = map.get(identity) ?? {
          id: result.monitor_id,
          time: window,
          stage: result.stage ?? '',
          failures: 0,
        }
        delta.failures++
        map.set(identity, delta)
      }
    }
    if (result.time > (latest.get(result.monitor_id)?.time ?? -1))
      latest.set(result.monitor_id, result)
    const value = {
      ...(result.certificate_expires_at !== undefined && {
        certificateExpiresAt: result.certificate_expires_at,
      }),
      ...(result.certificate_days_remaining !== undefined && {
        certificateDaysRemaining: result.certificate_days_remaining,
      }),
      ...(result.icmp_latency_ms !== undefined && { icmpLatencyMs: result.icmp_latency_ms }),
    }
    if (Object.keys(value).length)
      details.push({ id: result.monitor_id, time: result.time, value: JSON.stringify(value) })
  }
  const prior = await env.UPTIMEFLARE_D1.prepare(
    `SELECT monitor_id,time,checks,failures,latency_sum FROM probe_buckets WHERE probe_id=? AND
      (monitor_id,time) IN (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?))`
  )
    .bind(
      probeId,
      JSON.stringify(Array.from(buckets.values(), (bucket) => [bucket.id, bucket.time]))
    )
    .all<{
      monitor_id: string
      time: number
      checks: number
      failures: number
      latency_sum: number
    }>()
  if (!prior.success) throw new Error('Probe bucket read failed')
  const previous = new Map(prior.results.map((row) => [key(row.monitor_id, row.time), row])),
    days = new Map<string, Day>()
  for (const bucket of buckets.values()) {
    const time = Math.floor(bucket.time / 86400) * 86400,
      identity = key(bucket.id, time),
      before = previous.get(key(bucket.id, bucket.time)),
      delta = days.get(identity) ?? {
        id: bucket.id,
        time,
        checks: 0,
        failures: 0,
        sum: 0,
        latencyChecks: 0,
        latencySum: 0,
      },
      checks = before?.checks ?? 0,
      failed = before?.failures ?? 0,
      sum = before?.latency_sum ?? 0
    delta.checks += bucket.checks
    delta.failures += bucket.failures
    // A late failure removes the former successful bucket from latency averages.
    delta.latencyChecks +=
      (failed + bucket.failures === 0 ? checks + bucket.checks : 0) - (failed === 0 ? checks : 0)
    delta.latencySum +=
      (failed + bucket.failures === 0 ? sum + bucket.sum : 0) - (failed === 0 ? sum : 0)
    days.set(identity, delta)
  }
  const statements: D1PreparedStatement[] = []
  const counters = await prepareProbeCounters(
    env,
    Array.from(totals.values(), (delta) => ({
      probe_id: probeId,
      monitor_id: delta.id,
      checks: delta.checks,
      failures: delta.failures,
      latency_sum: delta.sum,
    })),
    Array.from(stages.values(), (delta) => ({
      probe_id: probeId,
      monitor_id: delta.id,
      stage: delta.stage,
      failures: delta.failures,
    })),
    guard
  )
  const legacyTotals = Array.from(totals.values()).filter(
      (delta) => !counters.active.has(counterKey(probeId, delta.id))
    ),
    legacyStages = Array.from(stages.values()).filter(
      (delta) => !counters.active.has(counterKey(probeId, delta.id))
    )
  statements.push(...counters.statements)
  const insert = (sql: string, values: unknown[]) =>
    statements.push(env.UPTIMEFLARE_D1.prepare(sql).bind(probeId, JSON.stringify(values)))
  insert(
    `INSERT INTO probe_days(probe_id,monitor_id,time,checks,failures,latency_checks,latency_sum) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.time'),json_extract(value,'$.checks'),json_extract(value,'$.failures'),json_extract(value,'$.latencyChecks'),json_extract(value,'$.latencySum') FROM json_each(?) WHERE (${guard}) ON CONFLICT(probe_id,monitor_id,time) DO UPDATE SET checks=probe_days.checks+excluded.checks,failures=probe_days.failures+excluded.failures,latency_checks=probe_days.latency_checks+excluded.latency_checks,latency_sum=probe_days.latency_sum+excluded.latency_sum`,
    [...days.values()]
  )
  insert(
    `INSERT INTO probe_buckets(probe_id,monitor_id,time,checks,failures,latency_sum) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.time'),json_extract(value,'$.checks'),json_extract(value,'$.failures'),json_extract(value,'$.sum') FROM json_each(?) WHERE (${guard}) ON CONFLICT(probe_id,monitor_id,time) DO UPDATE SET checks=probe_buckets.checks+excluded.checks,failures=probe_buckets.failures+excluded.failures,latency_sum=probe_buckets.latency_sum+excluded.latency_sum`,
    [...buckets.values()]
  )
  if (legacyTotals.length)
    insert(
      `INSERT INTO probe_totals(probe_id,monitor_id,checks,failures,latency_sum) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.checks'),json_extract(value,'$.failures'),json_extract(value,'$.sum') FROM json_each(?) WHERE (${guard}) ON CONFLICT(probe_id,monitor_id) DO UPDATE SET checks=probe_totals.checks+excluded.checks,failures=probe_totals.failures+excluded.failures,latency_sum=probe_totals.latency_sum+excluded.latency_sum`,
      legacyTotals
    )
  if (legacyStages.length)
    insert(
      `INSERT INTO probe_stage_totals(probe_id,monitor_id,stage,failures) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.stage'),json_extract(value,'$.failures') FROM json_each(?) WHERE (${guard}) ON CONFLICT(probe_id,monitor_id,stage) DO UPDATE SET failures=probe_stage_totals.failures+excluded.failures`,
      legacyStages
    )
  statements.push(...(await preparePackedFailures(env, probeId, results, guard)))
  insert(
    `INSERT INTO probe_latest(probe_id,monitor_id,time,up,latency_ms,stage,code,message) SELECT ?,json_extract(value,'$.monitor_id'),json_extract(value,'$.time'),json_extract(value,'$.up'),json_extract(value,'$.latency_ms'),COALESCE(json_extract(value,'$.stage'),''),COALESCE(json_extract(value,'$.code'),''),COALESCE(json_extract(value,'$.message'),'') FROM json_each(?) WHERE (${guard}) ON CONFLICT(probe_id,monitor_id) DO UPDATE SET time=excluded.time,up=excluded.up,latency_ms=excluded.latency_ms,stage=excluded.stage,code=excluded.code,message=excluded.message WHERE excluded.time>probe_latest.time`,
    [...latest.values()]
  )
  if (details.length)
    insert(
      `INSERT OR IGNORE INTO probe_sample_details(probe_id,monitor_id,time,details) SELECT ?,json_extract(value,'$.id'),json_extract(value,'$.time'),json_extract(value,'$.value') FROM json_each(?) WHERE (${guard})`,
      details
    )
  return statements
}
