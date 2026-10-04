import type { MaintenanceConfig, MonitorState, MonitorTarget } from '../types/config'
import type { ProbeMonitorSummary } from '../types/probes'
import { getMonitorStatus, type MonitorStatus } from './probe-status'

export type MonitorCategory = 'healthy' | 'closed' | 'maintenance' | 'abnormal'
export const categoryLabels: Record<MonitorCategory, string> = {
  healthy: 'Healthy',
  closed: 'Closed',
  maintenance: 'Maintenance',
  abnormal: 'Abnormal',
}
export const categoryColors: Record<MonitorCategory, string> = {
  healthy: '#059669',
  closed: '#70778c',
  maintenance: '#d99b00',
  abnormal: '#df484a',
}

const epoch = (time: number | string) =>
  typeof time === 'number' ? (time < 1e12 ? time : time / 1000) : Date.parse(time) / 1000

export function getActiveMaintenance(
  monitor: Pick<MonitorTarget, 'id'>,
  maintenances: readonly MaintenanceConfig[],
  now: number
) {
  return maintenances.find(
    (plan) =>
      (!plan.monitors?.length || plan.monitors.includes(monitor.id)) &&
      epoch(plan.start) <= now &&
      (plan.end === undefined || epoch(plan.end) >= now)
  )
}

/** Lifecycle takes priority over measurements; historical buckets stay unchanged. */
export function getMonitorCategory(
  monitor: Pick<MonitorTarget, 'id' | 'paused'>,
  status: MonitorStatus | 'paused',
  maintenances: readonly MaintenanceConfig[],
  now: number
): MonitorCategory {
  if (monitor.paused || status === 'paused') return 'closed'
  if (getActiveMaintenance(monitor, maintenances, now)) return 'maintenance'
  return status === 'up' ? 'healthy' : 'abnormal'
}

export type DashboardCounts = Record<MonitorCategory, number> & {
  total: number
  lastUpdate: number
}

export function dashboardCategory(counts: DashboardCounts): MonitorCategory {
  if (counts.abnormal) return 'abnormal'
  if (counts.maintenance) return 'maintenance'
  return counts.healthy ? 'healthy' : 'closed'
}

export function summarizeDashboardMonitors(
  monitors: readonly MonitorTarget[],
  state: MonitorState,
  summaries: Record<string, ProbeMonitorSummary>,
  maintenances: readonly MaintenanceConfig[],
  now: number
): DashboardCounts {
  const counts: DashboardCounts = {
    healthy: 0,
    closed: 0,
    maintenance: 0,
    abnormal: 0,
    total: monitors.length,
    lastUpdate: 0,
  }
  for (const monitor of monitors) {
    const summary = summaries[monitor.id]
    const status =
      summary?.paused || summary?.status === 'paused'
        ? 'paused'
        : getMonitorStatus(monitor, state, summaries, now)
    const category = getMonitorCategory(monitor, status, maintenances, now)
    counts[category]++
    if (category === 'closed') continue
    const latest = monitor.probes?.length
      ? summary?.latest
      : state.latency[monitor.id]?.slice(-1)[0]?.time
    counts.lastUpdate = Math.max(counts.lastUpdate, latest ?? 0)
  }
  return counts
}
