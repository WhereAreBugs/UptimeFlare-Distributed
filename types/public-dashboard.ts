import type { MaintenanceConfig, PageConfig } from './config'
import type { ProbeMonitorSummary } from './probes'

export const PUBLIC_SNAPSHOT_MAX_AGE_SECONDS = 180

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
