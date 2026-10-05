import type { ProbeEnv } from './probes'
import { FAILURE_PREFIX, FAILURE_MARKER, FAILURE_DAY } from './packed-failures'
export const RAW_RETENTION_SECONDS = 90 * 86400,
  CLEANUP_BLOCKS = 128
/** Indexed keyset deletion. No pending deliveries or open incidents are expired. */
export async function cleanupStateV2(env: ProbeEnv, now: number) {
  const slot = Math.floor(now / 3600),
    cutoff = now - RAW_RETENTION_SECONDS
  const claimed = await env.UPTIMEFLARE_D1.prepare(
    "INSERT INTO uptimeflare(key,value) VALUES('state-v2-cleanup',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE CAST(uptimeflare.value AS INTEGER)<CAST(excluded.value AS INTEGER)"
  )
    .bind(String(slot))
    .run()
  if (!claimed.meta.changes) return false
  const statements = [
    env.UPTIMEFLARE_D1.prepare(
      `DELETE FROM probe_result_blocks WHERE (probe_id,window,chunk) IN(SELECT probe_id,window,chunk FROM probe_result_blocks WHERE window<? ORDER BY window LIMIT ${CLEANUP_BLOCKS})`
    ).bind(cutoff - 300),
    env.UPTIMEFLARE_D1.prepare(
      `DELETE FROM probe_failure_events WHERE (probe_id,monitor_id,time) IN(
        SELECT f.probe_id,f.monitor_id,f.time FROM probe_failure_events f WHERE f.time<? AND
        (f.stage<>? OR (f.time<? AND NOT EXISTS(SELECT 1 FROM probe_buckets b
          WHERE b.probe_id=f.probe_id AND b.monitor_id=substr(f.monitor_id,?)
            AND b.time>=CAST(f.time/${FAILURE_DAY} AS INTEGER)*${FAILURE_DAY}
            AND b.time<(CAST(f.time/${FAILURE_DAY} AS INTEGER)+1)*${FAILURE_DAY})))
        ORDER BY f.time LIMIT 1000)`
    ).bind(
      cutoff,
      FAILURE_MARKER,
      Math.floor(cutoff / FAILURE_DAY) * FAILURE_DAY,
      FAILURE_PREFIX.length + 1
    ),
    env.UPTIMEFLARE_D1.prepare(
      `DELETE FROM native_latency_blocks WHERE (monitor_id,window) IN(SELECT monitor_id,window FROM native_latency_blocks WHERE window<? ORDER BY window LIMIT ${CLEANUP_BLOCKS})`
    ).bind(cutoff - 300),
    env.UPTIMEFLARE_D1.prepare(
      'DELETE FROM native_incident_reasons WHERE (monitor_id,incident_start,time) IN(SELECT r.monitor_id,r.incident_start,r.time FROM native_incidents i JOIN native_incident_reasons r ON r.monitor_id=i.monitor_id AND r.incident_start=i.start WHERE i.end<? ORDER BY i.end LIMIT 1000)'
    ).bind(cutoff),
    env.UPTIMEFLARE_D1.prepare(
      'DELETE FROM native_incidents WHERE (monitor_id,start) IN(SELECT monitor_id,start FROM native_incidents i WHERE end<? AND NOT EXISTS(SELECT 1 FROM native_incident_reasons r WHERE r.monitor_id=i.monitor_id AND r.incident_start=i.start) ORDER BY end LIMIT 128)'
    ).bind(cutoff),
    env.UPTIMEFLARE_D1.prepare(
      'DELETE FROM notification_deliveries WHERE (event_id,destination) IN(SELECT d.event_id,d.destination FROM notification_deliveries d WHERE delivered_at<? AND NOT EXISTS(SELECT 1 FROM notification_outbox o WHERE o.event_id=d.event_id) ORDER BY delivered_at LIMIT 1000)'
    ).bind(cutoff),
  ]
  // Successful batch identities outlive the ninety-day raw window by seven days. Unexpired receipts are never evicted.
  statements.push(
    env.UPTIMEFLARE_D1.prepare(
      'DELETE FROM commit_runs WHERE run_id IN(SELECT run_id FROM commit_runs WHERE committed_at<? ORDER BY committed_at LIMIT 1000)'
    ).bind(cutoff - 7 * 86400)
  )
  try {
    const results = await env.UPTIMEFLARE_D1.batch(statements)
    if (results.some((r) => !r.success)) throw new Error('Incremental retention failed')
    return true
  } catch (error) {
    await env.UPTIMEFLARE_D1.prepare(
      "DELETE FROM uptimeflare WHERE key='state-v2-cleanup' AND value=?"
    )
      .bind(String(slot))
      .run()
    throw error
  }
}
