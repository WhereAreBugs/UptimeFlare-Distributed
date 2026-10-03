import type { MonitorState, MonitorTarget } from '../types/config'
import type { ProbeMonitorSummary } from '../types/probes'

export type MonitorStatus = 'up' | 'degraded' | 'down' | 'unknown'

export const statusColors: Record<MonitorStatus, string> = {
  up: '#059669',
  degraded: '#f29030',
  down: '#df484a',
  unknown: '#70778c',
}

export function aggregateStatus(up: number, down: number, unknown: number): MonitorStatus {
  const total = up + down + unknown
  if (total === 0 || unknown === total) return 'unknown'
  if (up === total) return 'up'
  if (down === total) return 'down'
  return 'degraded'
}

// Recheck freshness while a page is open: stale success must never remain green.
export function refreshProbeSummary(
  summary: ProbeMonitorSummary,
  now: number,
  staleAfterSeconds = 900
): ProbeMonitorSummary {
  const probes = summary.probes.map((probe) => {
    const stale = probe.stale || (probe.latest !== null && now - probe.latest > staleAfterSeconds)
    return {
      ...probe,
      stale,
      status: stale || probe.latest === null ? ('unknown' as const) : probe.status,
    }
  })
  const up = probes.filter((probe) => probe.status === 'up').length
  const down = probes.filter((probe) => probe.status === 'down').length
  const unknown = probes.length - up - down
  return {
    ...summary,
    probes,
    up,
    down,
    unknown,
    total: probes.length,
    status: aggregateStatus(up, down, unknown),
  }
}

export function getMonitorStatus(
  monitor: MonitorTarget,
  state: MonitorState,
  summaries: Record<string, ProbeMonitorSummary>,
  now: number,
  staleAfterSeconds = 900
): MonitorStatus {
  if (monitor.probes?.length) {
    const summary = summaries[monitor.id]
    return summary ? refreshProbeSummary(summary, now, staleAfterSeconds).status : 'unknown'
  }
  if (!state.latency[monitor.id]?.length || !state.incident[monitor.id]?.length) return 'unknown'
  const incident = state.incident[monitor.id]?.slice(-1)[0]
  return incident?.end === null ? 'down' : 'up'
}

export function summarizeMonitors(
  monitors: MonitorTarget[],
  state: MonitorState,
  summaries: Record<string, ProbeMonitorSummary>,
  now: number,
  staleAfterSeconds = 900
) {
  const counts = { up: 0, down: 0, degraded: 0, unknown: 0, total: monitors.length, lastUpdate: 0 }
  for (const monitor of monitors) {
    counts[getMonitorStatus(monitor, state, summaries, now, staleAfterSeconds)]++
    const latest = monitor.probes?.length ? summaries[monitor.id]?.latest : state.lastUpdate
    counts.lastUpdate = Math.max(counts.lastUpdate, latest ?? 0)
  }
  return counts
}
