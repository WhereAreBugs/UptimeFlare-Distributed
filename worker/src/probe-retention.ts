import type { ProbeEnv } from './probes'
import { cleanupStateV2 } from './retention-v2'
import { beginCommit, endCommit, releaseCommit } from './commit'
import { getRuntimeConfig } from './settings'
import { workerConfig } from '../../uptime.config'
import {
  prepareProbeCounters,
  counterKey,
  type CounterDelta,
  type StageDelta,
} from './probe-counters'

/** The same short commit lease protects read/modify/write counter documents
 * during ingestion and expiration. One hourly claim bounds every cleanup pass. */
export async function cleanupPackedProbeResults(env: ProbeEnv, now: number) {
  if (!(await cleanupStateV2(env, now))) return
  const slot = Math.floor(now / 3600)
  let lease: Awaited<ReturnType<typeof beginCommit>> | undefined
  try {
    const config = await getRuntimeConfig(env, workerConfig, false)
    lease = await beginCommit(env, 'probe-retention:' + slot, { slot }, config)
    if (lease.replay) return
    const cutoff = now - 90 * 86400,
      expired = await env.UPTIMEFLARE_D1.prepare(
        'SELECT probe_id,monitor_id,time,checks,failures,latency_sum FROM probe_buckets WHERE time<? ORDER BY time,probe_id,monitor_id LIMIT 1000'
      )
        .bind(cutoff)
        .all<CounterDelta & { time: number }>()
    if (!expired.success) throw new Error('Probe expiration read failed')
    const keys = JSON.stringify(
        expired.results.map((row) => [row.probe_id, row.monitor_id, row.time])
      ),
      scope = `(probe_id,monitor_id,time) IN (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]'),json_extract(value,'$[2]') FROM json_each(?))`,
      stageRows = expired.results.length
        ? await env.UPTIMEFLARE_D1.prepare(
            `SELECT probe_id,monitor_id,time,stage,failures FROM probe_bucket_stages WHERE ${scope}`
          )
            .bind(keys)
            .all<StageDelta>()
        : { success: true, results: [] as StageDelta[] }
    if (!stageRows.success) throw new Error('Probe stage expiration read failed')
    const days = new Map<string, CounterDelta & { time: number; latency_checks: number }>(),
      totals = new Map<string, CounterDelta>(),
      stages = new Map<string, StageDelta>()
    for (const row of expired.results) {
      const identity = counterKey(row.probe_id, row.monitor_id),
        time = Math.floor(row.time / 86400) * 86400,
        total = totals.get(identity) ?? {
          probe_id: row.probe_id,
          monitor_id: row.monitor_id,
          checks: 0,
          failures: 0,
          latency_sum: 0,
        },
        day = days.get(identity + '\0' + time) ?? {
          ...total,
          time,
          checks: 0,
          failures: 0,
          latency_sum: 0,
          latency_checks: 0,
        }
      total.checks -= row.checks
      total.failures -= row.failures
      total.latency_sum -= row.latency_sum
      day.checks -= row.checks
      day.failures -= row.failures
      if (!row.failures) {
        day.latency_checks -= row.checks
        day.latency_sum -= row.latency_sum
      }
      totals.set(identity, total)
      days.set(identity + '\0' + time, day)
    }
    for (const row of stageRows.results) {
      const identity = counterKey(row.probe_id, row.monitor_id) + '\0' + row.stage,
        delta = stages.get(identity) ?? {
          probe_id: row.probe_id,
          monitor_id: row.monitor_id,
          stage: row.stage,
          failures: 0,
        }
      delta.failures -= row.failures
      stages.set(identity, delta)
    }
    const counters = await prepareProbeCounters(
        env,
        [...totals.values()],
        [...stages.values()],
        lease.guard,
        false
      ),
      legacyTotals = [...totals.values()].filter(
        (row) => !counters.active.has(counterKey(row.probe_id, row.monitor_id))
      ),
      legacyStages = [...stages.values()].filter(
        (row) => !counters.active.has(counterKey(row.probe_id, row.monitor_id))
      ),
      statements = [...counters.statements],
      guard = lease.guard
    if (days.size)
      statements.push(
        env.UPTIMEFLARE_D1.prepare(
          `INSERT INTO probe_days(probe_id,monitor_id,time,checks,failures,latency_checks,latency_sum) SELECT json_extract(value,'$.probe_id'),json_extract(value,'$.monitor_id'),json_extract(value,'$.time'),json_extract(value,'$.checks'),json_extract(value,'$.failures'),json_extract(value,'$.latency_checks'),json_extract(value,'$.latency_sum') FROM json_each(?) WHERE (${guard}) ON CONFLICT(probe_id,monitor_id,time) DO UPDATE SET checks=probe_days.checks+excluded.checks,failures=probe_days.failures+excluded.failures,latency_checks=probe_days.latency_checks+excluded.latency_checks,latency_sum=probe_days.latency_sum+excluded.latency_sum`
        ).bind(JSON.stringify([...days.values()]))
      )
    if (legacyTotals.length)
      statements.push(
        env.UPTIMEFLARE_D1.prepare(
          `INSERT INTO probe_totals(probe_id,monitor_id,checks,failures,latency_sum) SELECT json_extract(value,'$.probe_id'),json_extract(value,'$.monitor_id'),json_extract(value,'$.checks'),json_extract(value,'$.failures'),json_extract(value,'$.latency_sum') FROM json_each(?) WHERE (${guard}) ON CONFLICT(probe_id,monitor_id) DO UPDATE SET checks=probe_totals.checks+excluded.checks,failures=probe_totals.failures+excluded.failures,latency_sum=probe_totals.latency_sum+excluded.latency_sum`
        ).bind(JSON.stringify(legacyTotals))
      )
    if (legacyStages.length)
      statements.push(
        env.UPTIMEFLARE_D1.prepare(
          `INSERT INTO probe_stage_totals(probe_id,monitor_id,stage,failures) SELECT json_extract(value,'$.probe_id'),json_extract(value,'$.monitor_id'),json_extract(value,'$.stage'),json_extract(value,'$.failures') FROM json_each(?) WHERE (${guard}) ON CONFLICT(probe_id,monitor_id,stage) DO UPDATE SET failures=probe_stage_totals.failures+excluded.failures`
        ).bind(JSON.stringify(legacyStages))
      )
    statements.push(
      env.UPTIMEFLARE_D1.prepare(
        `DELETE FROM probe_bucket_stages WHERE ${scope} AND (${guard})`
      ).bind(keys),
      env.UPTIMEFLARE_D1.prepare(`DELETE FROM probe_buckets WHERE ${scope} AND (${guard})`).bind(
        keys
      ),
      env.UPTIMEFLARE_D1.prepare(
        `DELETE FROM probe_days WHERE (probe_id,monitor_id,time) IN (SELECT probe_id,monitor_id,time FROM probe_days WHERE checks<=0 LIMIT 1000) AND (${guard})`
      ),
      env.UPTIMEFLARE_D1.prepare(
        `DELETE FROM probe_sample_details WHERE (probe_id,monitor_id,time) IN (SELECT d.probe_id,d.monitor_id,d.time FROM probe_sample_details d WHERE d.time<? AND NOT EXISTS(SELECT 1 FROM probe_latest l WHERE l.probe_id=d.probe_id AND l.monitor_id=d.monitor_id AND l.time=d.time) ORDER BY d.time,d.probe_id,d.monitor_id LIMIT 5000) AND (${guard})`
      ).bind(cutoff),
      env.UPTIMEFLARE_D1.prepare(
        `DELETE FROM probe_samples WHERE (probe_id,monitor_id,time) IN (SELECT probe_id,monitor_id,time FROM probe_samples WHERE time<? ORDER BY time,probe_id,monitor_id LIMIT 5000) AND (${guard})`
      ).bind(cutoff)
    )
    if (!(await endCommit(env, lease, statements)))
      throw new Error('Probe expiration lease/config changed')
  } catch (error) {
    // A failed statistics transaction must be retryable within the same hour.
    await env.UPTIMEFLARE_D1.prepare(
      "DELETE FROM uptimeflare WHERE key='state-v2-cleanup' AND value=?"
    )
      .bind(String(slot))
      .run()
      .catch(() => undefined)
    throw error
  } finally {
    if (lease) await releaseCommit(env, lease)
  }
}
