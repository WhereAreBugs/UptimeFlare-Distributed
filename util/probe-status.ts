import type { MonitorState, MonitorTarget } from '../types/config'
import type {
  ProbeDailyBucket,
  ProbeHistoryBucket,
  ProbeMonitorSummary,
  ProbeSummary,
} from '../types/probes'
import { getMonitorIntervalSeconds, getMonitorStaleAfterSeconds } from './monitor-settings'

export type MonitorStatus = 'up' | 'degraded' | 'down' | 'unknown'

export const statusColors: Record<MonitorStatus, string> = {
  up: '#059669',
  degraded: '#f29030',
  down: '#df484a',
  unknown: '#70778c',
}

export function aggregateStatus(
  up: number,
  down: number,
  unknown: number,
  degraded = 0
): MonitorStatus {
  const total = up + down + unknown + degraded
  if (total === 0 || unknown === total) return 'unknown'
  if (up === total - unknown) return 'up'
  if (down === total - unknown) return 'down'
  return 'degraded'
}

export type MonitorHistoryBucket = ProbeHistoryBucket & {
  status: MonitorStatus
  reported: number
  total: number
}

// Only probes with samples affect the color; missing data stays visible in coverage.
// Reporting probes have equal weight, regardless of their check intervals.
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
      if (bucket.failures === 0 && bucket.avgLatencyMs !== null) {
        latencySum += bucket.avgLatencyMs * bucket.checks
        latencyChecks += bucket.checks
      }
    }
    const status: MonitorStatus =
      reported === 0 ? 'unknown' : up === reported ? 'up' : down === reported ? 'down' : 'degraded'
    return {
      time,
      status,
      reported,
      total: probes.length,
      checks,
      failures,
      avgLatencyMs: failures === 0 && latencyChecks ? latencySum / latencyChecks : null,
    }
  })
}

/** Fill absent days with null; never infer a check or failure from an offline probe. */
export function summarizeProbeDailyHistory(
  probes: Pick<ProbeSummary, 'dailyHistory'>[],
  now: number
): ProbeDailyBucket[] {
  const days = new Map<number, ProbeDailyBucket>()
  for (const probe of probes) {
    for (const bucket of probe.dailyHistory ?? []) {
      const day = days.get(bucket.time) ?? {
        time: bucket.time,
        checks: 0,
        failures: 0,
        avgLatencyMs: null,
        latencyChecks: 0,
        uptimePercent: null,
      }
      const previousSum = (day.avgLatencyMs ?? 0) * day.latencyChecks
      day.checks += bucket.checks
      day.failures += bucket.failures
      day.latencyChecks += bucket.latencyChecks
      day.avgLatencyMs = day.latencyChecks
        ? (previousSum + (bucket.avgLatencyMs ?? 0) * bucket.latencyChecks) / day.latencyChecks
        : null
      day.uptimePercent = day.checks ? (100 * (day.checks - day.failures)) / day.checks : null
      days.set(bucket.time, day)
    }
  }
  const end = Math.floor(now / 86400) * 86400
  return Array.from({ length: 90 }, (_, index) => {
    const time = end - (89 - index) * 86400
    return (
      days.get(time) ?? {
        time,
        checks: 0,
        failures: 0,
        avgLatencyMs: null,
        latencyChecks: 0,
        uptimePercent: null,
      }
    )
  })
}

/** Native latency records encode failed checks as zero; incidents disambiguate true zero latency. */
export function nativeLatencyPoints(
  monitor: Pick<MonitorTarget, 'id' | 'intervalSeconds'>,
  state: MonitorState
) {
  const points: { x: number; y: number | null; loc: string }[] = []
  const cadence = Math.ceil(getMonitorIntervalSeconds(monitor) / 60) * 60
  const incidents = (state.incident[monitor.id] ?? []).filter(
    (incident) => incident.error[0] !== 'dummy'
  )
  let incidentIndex = 0
  let previous: number | undefined
  for (const point of state.latency[monitor.id] ?? []) {
    if (previous !== undefined && point.time - previous > cadence) {
      points.push({ x: (previous + cadence) * 1000, y: null, loc: '' })
    }
    while (
      incidents[incidentIndex]?.end !== null &&
      incidents[incidentIndex]?.end !== undefined &&
      incidents[incidentIndex].end! <= point.time
    )
      incidentIndex++
    const incident = incidents[incidentIndex]
    const failed =
      !!incident &&
      incident.start[0] <= point.time &&
      (incident.end === null || point.time < incident.end)
    points.push({ x: point.time * 1000, y: failed ? null : point.ping, loc: point.loc })
    previous = point.time
  }
  return points
}

// Recheck freshness while a page is open: stale success must never remain green.
export function refreshProbeSummary(
  summary: ProbeMonitorSummary,
  now: number,
  monitor: Pick<MonitorTarget, 'intervalSeconds'> = {}
): ProbeMonitorSummary {
  const staleAfterSeconds = getMonitorStaleAfterSeconds(monitor)
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
  now: number
): MonitorStatus {
  if (monitor.probes?.length) {
    const summary = summaries[monitor.id]
    return summary ? refreshProbeSummary(summary, now, monitor).status : 'unknown'
  }
  if (!state.latency[monitor.id]?.length || !state.incident[monitor.id]?.length) return 'unknown'
  const latency = state.latency[monitor.id].slice(-1)[0]
  if (now - latency.time > getMonitorStaleAfterSeconds(monitor)) return 'unknown'
  const incident = state.incident[monitor.id]?.slice(-1)[0]
  return incident?.end === null ? 'down' : 'up'
}

export function summarizeMonitors(
  monitors: MonitorTarget[],
  state: MonitorState,
  summaries: Record<string, ProbeMonitorSummary>,
  now: number
) {
  const counts = { up: 0, down: 0, degraded: 0, unknown: 0, total: monitors.length, lastUpdate: 0 }
  for (const monitor of monitors) {
    counts[getMonitorStatus(monitor, state, summaries, now)]++
    const latest = monitor.probes?.length
      ? summaries[monitor.id]?.latest
      : state.latency[monitor.id]?.slice(-1)[0]?.time
    counts.lastUpdate = Math.max(counts.lastUpdate, latest ?? 0)
  }
  return counts
}
