import type { MonitorState, MonitorTarget } from '../types/config'
import type { ProbeHistoryBucket, ProbeMonitorSummary, ProbeSummary } from '../types/probes'

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

export type MonitorHistoryBucket = ProbeHistoryBucket & {
  status: MonitorStatus
  reported: number
  total: number
}

// Each assigned probe has equal weight in the color, regardless of its check interval.
// Missing evidence cannot turn a partially observed interval green or red.
export function summarizeProbeHistory(
  probes: Pick<ProbeSummary, 'history'>[],
  now: number
): MonitorHistoryBucket[] {
  const histories = probes.map(
    (probe) => new Map(probe.history.map((bucket) => [bucket.time, bucket]))
  )
  const end = Math.floor(now / 300) * 300
  return Array.from({ length: 144 }, (_, index) => {
    const time = end - (143 - index) * 300
    let up = 0
    let down = 0
    let reported = 0
    let checks = 0
    let failures = 0
    let latencySum = 0
    let latencyChecks = 0
    for (const history of histories) {
      const bucket = history.get(time)
      if (!bucket?.checks) continue
      reported++
      checks += bucket.checks
      failures += bucket.failures
      if (bucket.failures === 0) up++
      else if (bucket.failures === bucket.checks) down++
      if (bucket.avgLatencyMs !== null) {
        latencySum += bucket.avgLatencyMs * bucket.checks
        latencyChecks += bucket.checks
      }
    }
    const status: MonitorStatus =
      reported === 0
        ? 'unknown'
        : up === probes.length
        ? 'up'
        : down === probes.length
        ? 'down'
        : 'degraded'
    return {
      time,
      status,
      reported,
      total: probes.length,
      checks,
      failures,
      avgLatencyMs: latencyChecks ? latencySum / latencyChecks : null,
    }
  })
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
