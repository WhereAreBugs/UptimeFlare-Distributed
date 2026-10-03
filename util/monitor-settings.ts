import type { MonitorTarget } from '../types/config'

export const DEFAULT_MONITOR_INTERVAL_SECONDS = 300
export const DEFAULT_MONITOR_TIMEOUT_MS = 5000
export const MIN_MONITOR_INTERVAL_SECONDS = 60
export const MAX_MONITOR_INTERVAL_SECONDS = 86400

export function getMonitorIntervalSeconds(monitor: Pick<MonitorTarget, 'intervalSeconds'>) {
  return monitor.intervalSeconds ?? DEFAULT_MONITOR_INTERVAL_SECONDS
}

export function getMonitorStaleAfterSeconds(monitor: Pick<MonitorTarget, 'intervalSeconds'>) {
  return getMonitorIntervalSeconds(monitor) * 2
}
