import type { ProbeEnv } from './probes'
import type { MonitorTarget, MonitorStateCompacted } from '../../types/config'
import { CompactedMonitorStateWrapper } from './store'
export type NativeHot = {
  monitor_id: string
  time: number
  up: number
  ping: number
  location: string
  error: string
  incident_start: number | null
  first_seen: number
  sequence: number
}
export function usesStateV2(env: ProbeEnv) {
  return env.STATE_STORAGE_VERSION === '2'
}
export async function nativeHot(env: ProbeEnv, ids?: string[]) {
  const rows = await env.UPTIMEFLARE_D1.prepare(
    'SELECT * FROM native_hot' +
      (ids ? ' WHERE monitor_id IN (SELECT value FROM json_each(?))' : '')
  )
  const result = await (ids ? rows.bind(JSON.stringify(ids)) : rows).all<NativeHot>()
  if (!result.success) throw new Error('Hot status read failed')
  return result.results
}
/** Compatibility encoding is scoped and cheap: summaries encode one point per target. */
export async function publicNativeV2(
  env: ProbeEnv,
  monitors: MonitorTarget[],
  history = false,
  from?: number,
  to?: number
): Promise<string | null> {
  const ids = monitors.filter((m) => !m.paused && !m.probes?.length).map((m) => m.id)
  if (!ids.length) return null
  const rows = await nativeHot(env, ids),
    state = new CompactedMonitorStateWrapper(null)
  const markers = await env.UPTIMEFLARE_D1.prepare(
    "SELECT monitor_id,sample_time FROM notification_observations WHERE status IN ('paused','awaiting') AND monitor_id IN (SELECT value FROM json_each(?))"
  )
    .bind(JSON.stringify(ids))
    .all<{ monitor_id: string; sample_time: number }>()
  if (!markers.success) throw new Error('Lifecycle marker read failed')
  const awaiting = new Map(markers.results.map((row) => [row.monitor_id, row.sample_time]))
  for (const row of rows) {
    state.data.lastUpdate = Math.max(state.data.lastUpdate, row.time)
    state.appendIncident(row.monitor_id, {
      start: [row.incident_start ?? row.first_seen ?? row.time],
      end: row.up ? row.time : null,
      error: [row.error || 'dummy'],
    })
    if (row.time > (awaiting.get(row.monitor_id) ?? -1))
      state.appendLatency(row.monitor_id, { time: row.time, ping: row.ping, loc: row.location })
  }
  if (history) {
    const incidentFrom = from ?? Math.floor(Date.now() / 1000) - 90 * 86400
    const start = from ?? Math.floor(Date.now() / 1000) - 43200,
      end = to ?? Math.floor(Date.now() / 1000) + 1
    const [blocks, incidents, reasons] = await env.UPTIMEFLARE_D1.batch([
      env.UPTIMEFLARE_D1.prepare(
        'SELECT monitor_id,value FROM native_latency_blocks WHERE monitor_id IN (SELECT value FROM json_each(?)) AND window>=? AND window<? ORDER BY window LIMIT 1500'
      ).bind(JSON.stringify(ids), Math.floor(start / 300) * 300, end),
      env.UPTIMEFLARE_D1.prepare(
        'SELECT * FROM native_incidents WHERE monitor_id IN (SELECT value FROM json_each(?)) AND start<? AND (end IS NULL OR end>=?) ORDER BY start DESC LIMIT 200'
      ).bind(JSON.stringify(ids), end, incidentFrom),
      env.UPTIMEFLARE_D1.prepare(
        'SELECT * FROM native_incident_reasons WHERE monitor_id IN (SELECT value FROM json_each(?)) AND incident_start IN (SELECT start FROM native_incidents WHERE monitor_id IN (SELECT value FROM json_each(?)) AND start<? AND (end IS NULL OR end>=?) ORDER BY start DESC LIMIT 200) ORDER BY time LIMIT 4000'
      ).bind(JSON.stringify(ids), JSON.stringify(ids), end, incidentFrom),
    ])
    if ([blocks, incidents, reasons].some((r) => !r.success))
      throw new Error('Native history read failed')
    state.data.latency = {}
    state.data.incident = {}
    for (const row of rows)
      state.appendIncident(row.monitor_id, {
        start: [row.first_seen ?? row.time],
        end: row.first_seen ?? row.time,
        error: ['dummy'],
      })
    for (const block of blocks.results as { monitor_id: string; value: string }[])
      for (const sample of JSON.parse(block.value) as { time: number; ping: number; loc: string }[])
        if (sample.time >= start && sample.time < end) state.appendLatency(block.monitor_id, sample)
    for (const row of [
      ...(incidents.results as { monitor_id: string; start: number; end: number | null }[]),
    ].reverse()) {
      const changes = (
        reasons.results as {
          monitor_id: string
          incident_start: number
          time: number
          error: string
        }[]
      ).filter((r) => r.monitor_id === row.monitor_id && r.incident_start === row.start)
      state.appendIncident(row.monitor_id, {
        start: changes.length ? changes.map((c) => c.time) : [row.start],
        end: row.end,
        error: changes.length
          ? changes.map((c) => c.error)
          : ['[unknown/unknown] Historical failure'],
      })
    }
    for (const row of rows)
      if (!state.incidentLen(row.monitor_id))
        state.appendIncident(row.monitor_id, {
          start: [row.time],
          end: row.up ? row.time : null,
          error: [row.error || 'dummy'],
        })
  }
  return state.getCompactedStateStr()
}
