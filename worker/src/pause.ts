import { usesStateV2 } from './storage-v2'
import type { ProbeEnv } from './probes'
import type { MonitorTarget } from '../../types/config'

export type PauseTransition = { id: string; paused: boolean; native?: boolean }

const matchesSavedPause = (value: string) =>
  `NOT EXISTS (SELECT 1 FROM admin_config config,json_each(json_extract(config.value,'$.monitors')) saved
    WHERE config.id=1 AND json_extract(saved.value,'$.id')=json_extract(${value},'$.id')
      AND COALESCE(json_extract(saved.value,'$.paused'),0)<>json_extract(${value},'$.paused'))`

/** The existing observation row also fences notifications until post-resume samples arrive. */
export function pauseTransitionStatements(
  env: ProbeEnv,
  transitions: PauseTransition[],
  now: number,
  guard = '1',
  resetExisting = true
): D1PreparedStatement[] {
  if (!transitions.length) return []
  const payload = JSON.stringify(transitions)
  const ids = `SELECT json_extract(entry.value,'$.id') FROM json_each(?) entry WHERE ${matchesSavedPause(
    'entry.value'
  )}`
  const statements = [
    env.UPTIMEFLARE_D1.prepare(
      `DELETE FROM notification_outbox WHERE monitor_id IN (${ids}) AND (${guard})`
    ).bind(payload),
    env.UPTIMEFLARE_D1.prepare(
      `DELETE FROM notification_state WHERE monitor_id IN (${ids}) AND (${guard})`
    ).bind(payload),
    env.UPTIMEFLARE_D1.prepare(
      `INSERT INTO notification_observations
      (monitor_id,template_id,status,down_since,sample_time,observed_at,reason,notified,version)
      SELECT json_extract(entry.value,'$.id'),'',CASE WHEN json_extract(entry.value,'$.paused') THEN 'paused' ELSE 'awaiting' END,NULL,?,?,'',0,0
      FROM json_each(?) entry WHERE (${guard}) AND ${matchesSavedPause('entry.value')}
      ON CONFLICT(monitor_id) DO UPDATE SET template_id='',status=excluded.status,down_since=NULL,
        sample_time=excluded.sample_time,observed_at=excluded.observed_at,reason='',notified=0,
        version=notification_observations.version+1
      WHERE notification_observations.status<>excluded.status OR ?`
    ).bind(now, now, payload, resetExisting ? 1 : 0),
    env.UPTIMEFLARE_D1.prepare(
      `DELETE FROM monitor_schedule WHERE scope IN ('native','cloudflare') AND monitor_id IN (${ids}) AND (${guard})`
    ).bind(payload),
  ]
  if (transitions.some((transition) => transition.native))
    statements.push(
      env.UPTIMEFLARE_D1.prepare(
        `UPDATE monitor_schedule SET lease_until=0,lease_key='' WHERE scope='native-writer' AND monitor_id='state' AND (${guard}) AND EXISTS (${ids})`
      ).bind(payload)
    )
  if (usesStateV2(env)) {
    const pausedNative = `SELECT json_extract(entry.value,'$.id') FROM json_each(?) entry WHERE json_extract(entry.value,'$.paused')=1 AND json_extract(entry.value,'$.native')=1 AND ${matchesSavedPause(
      'entry.value'
    )}`
    statements.push(
      env.UPTIMEFLARE_D1.prepare(
        `UPDATE native_incidents SET end=MAX(start,?) WHERE end IS NULL AND monitor_id IN (${pausedNative}) AND (${guard})`
      ).bind(now, payload)
    )
    statements.push(
      env.UPTIMEFLARE_D1.prepare(
        `UPDATE native_hot SET up=1,error='',incident_start=NULL,sequence=sequence+1 WHERE monitor_id IN (${pausedNative}) AND (${guard})`
      ).bind(payload)
    )
  }
  return statements
}

/** A request that read configuration before a pause must not enqueue or start new work afterwards. */
export const NOT_PAUSED_IN_SAVED_CONFIG = (monitorId: string) =>
  `${monitorId} NOT IN (SELECT json_extract(monitor.value,'$.id') FROM admin_config config,json_each(json_extract(config.value,'$.monitors')) monitor
    WHERE config.id=1 AND json_extract(monitor.value,'$.paused')=1)`

/** Refresh only pause flags: no target, header, credential or notification payload is read. */
export async function withSavedPauseFlags(env: ProbeEnv, monitors: MonitorTarget[]) {
  const row = await env.UPTIMEFLARE_D1.prepare(
    `SELECT config.revision,(SELECT json_group_array(json_object('id',json_extract(monitor.value,'$.id'),
      'paused',COALESCE(json_extract(monitor.value,'$.paused'),0)))
    FROM json_each(json_extract(config.value,'$.monitors')) monitor
    WHERE json_extract(monitor.value,'$.id') IN (SELECT value FROM json_each(?))) flags
    FROM admin_config config WHERE config.id=1`
  )
    .bind(JSON.stringify(monitors.map((monitor) => monitor.id)))
    .first<{ revision: number; flags: string }>()
  if (row && !Number.isSafeInteger(row.revision)) throw new Error('Pause configuration read failed')
  const flags = new Map(
    (row ? (JSON.parse(row.flags) as { id: string; paused: number }[]) : []).map((value) => [
      value.id,
      !!value.paused,
    ])
  )
  return {
    monitors: monitors.map((monitor) =>
      flags.has(monitor.id) ? { ...monitor, paused: flags.get(monitor.id)! } : monitor
    ),
    // Fence all destructive reconciliation against a config change after the safe projection read.
    guard: row
      ? `EXISTS (SELECT 1 FROM admin_config WHERE id=1 AND revision=${row.revision})`
      : 'NOT EXISTS (SELECT 1 FROM admin_config WHERE id=1)',
  }
}
