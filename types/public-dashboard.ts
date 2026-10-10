import type { MaintenanceConfig, PageConfig } from './config'
import type { ProbeMonitorSummary } from './probes'

// Publication is every five minutes, with a ten-minute heartbeat when unchanged.
// Probe sample expiry remains independently bounded by twice its target interval.
export const PUBLIC_SNAPSHOT_MAX_AGE_SECONDS = 900
export const PUBLIC_CLIENT_REFRESH_SECONDS = 120
export const PUBLIC_EDGE_CACHE_SECONDS = 60

/** Public wire contract. Keep independent of the private check configuration. */
export type PublicMonitor = {
  id: string
  name: string
  // Empty compatibility fields for existing consumers; never the actual request URL/method.
  method: ''
  target: ''
  intervalSeconds: number
  paused?: boolean
  tooltip?: string
  statusPageLink?: string
  hideLatencyChart?: boolean
  probes?: string[]
}

/** Contains only fields already intended for the public status page. Never use for authorization. */
export type PublicDashboardSnapshot = {
  version: 1
  generatedAt: number
  configRevision: number
  complete: boolean
  monitors: PublicMonitor[]
  page: PageConfig
  maintenances: MaintenanceConfig[]
  probeSummaries: Record<string, ProbeMonitorSummary>
  compactedStateStr: string | null
}
export type PublicDashboard = Omit<
  PublicDashboardSnapshot,
  'version' | 'generatedAt' | 'complete'
> & {
  materializedAt?: number
  cachedAt?: number
  snapshotAt: number | null
  snapshotIncomplete: boolean
  stale: boolean
  source: 'kv' | 'd1' | 'recovery'
}
