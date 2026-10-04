import type { MonitorTarget } from '../../types/config'
import type { NativeIncidentPage, NativeIncidentRow } from '../../types/probes'
import type { ProbeEnv, ProbeIncidentQuery } from './probes'
import { CompactedMonitorStateWrapper, getFromStore } from './store'
import { classifyNativeFailure } from './diagnostics'
import { getMonitorStaleAfterSeconds } from '../../util/monitor-settings'

/** Native incidents retain the original duration/episode semantics, separately from probe checks. */
export async function getNativeIncidents(
  env: ProbeEnv,
  monitors: MonitorTarget[],
  query: ProbeIncidentQuery = {},
  now = Math.floor(Date.now() / 1000)
): Promise<NativeIncidentPage> {
  const from = Math.max(now - 90 * 86400, query.from ?? now - 90 * 86400)
  const to = Math.min(now + 1, query.to ?? now + 1)
  const limit = query.limit ?? 100
  if (
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from >= to ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  )
    throw new Error('Invalid incident history range or page size')
  if (query.monitorId && !monitors.some((monitor) => monitor.id === query.monitorId))
    throw new Error('Unknown monitor')
  let cursor: [number, string] = [to, '\uffff']
  if (query.cursor) {
    try {
      if (query.cursor.length > 1024) throw new Error('Invalid cursor')
      const decoded = JSON.parse(atob(query.cursor))
      if (
        !Array.isArray(decoded) ||
        decoded.length !== 2 ||
        !Number.isSafeInteger(decoded[0]) ||
        decoded[0] < from ||
        decoded[0] >= to ||
        typeof decoded[1] !== 'string' ||
        !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(decoded[1])
      )
        throw new Error('Invalid cursor')
      cursor = decoded as [number, string]
    } catch {
      throw new Error('Invalid incident cursor')
    }
  }
  const native = monitors.filter(
    (monitor) => !monitor.probes?.length && (!query.monitorId || query.monitorId === monitor.id)
  )
  if (!native.length) return { incidents: [], nextCursor: null, from, to }
  const state = new CompactedMonitorStateWrapper(await getFromStore(env as any, 'state'))
  const rows: NativeIncidentRow[] = []
  for (const monitor of native) {
    let count = 0
    // Scan backwards and stop before the requested month. No latency decoding is needed.
    for (let index = state.incidentLen(monitor.id) - 1; index >= 0; index--) {
      const incident = state.getIncident(monitor.id, index)
      if (incident.end !== null && incident.end < from) break
      if (incident.error[0] === 'dummy' || incident.start[0] >= to) continue
      const start = Math.max(from, incident.start[0])
      if (start > cursor[0] || (start === cursor[0] && monitor.id >= cursor[1])) continue
      const reasons: NativeIncidentRow['reasons'] = []
      for (let i = 0; i < incident.error.length; i++) {
        const end = incident.start[i + 1] ?? incident.end ?? to
        if (end <= from || incident.start[i] >= to) continue
        const diagnostic = classifyNativeFailure(incident.error[i])
        reasons.push({ time: Math.max(from, incident.start[i]), ...diagnostic })
      }
      rows.push({
        monitorId: monitor.id,
        monitorName: monitor.name,
        start,
        end: incident.end,
        continued: incident.start[0] < from,
        stale:
          incident.end === null &&
          (!state.latencyLen(monitor.id) ||
            state.getLastLatency(monitor.id).time < now - getMonitorStaleAfterSeconds(monitor)),
        reasons,
      })
      // Only the newest limit+1 episodes per monitor can appear on this page.
      if (++count > limit) break
    }
  }
  rows.sort(
    (a, b) =>
      b.start - a.start || (a.monitorId < b.monitorId ? 1 : a.monitorId > b.monitorId ? -1 : 0)
  )
  const incidents = rows.slice(0, limit)
  const last = incidents[incidents.length - 1]
  return {
    incidents,
    nextCursor:
      rows.length > limit && last ? btoa(JSON.stringify([last.start, last.monitorId])) : null,
    from,
    to,
  }
}
