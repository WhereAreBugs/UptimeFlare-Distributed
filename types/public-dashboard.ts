import type { MaintenanceConfig, MonitorTarget, PageConfig } from './config'
import type { ProbeMonitorSummary } from './probes'

export const PUBLIC_SNAPSHOT_MAX_AGE_SECONDS = 180

/** Contains only fields already intended for the public status page. Never use for authorization. */
export type PublicDashboardSnapshot = {
  version: 1
  generatedAt: number
  configRevision: number
  complete: boolean
  monitors: MonitorTarget[]
  page: PageConfig
  maintenances: MaintenanceConfig[]
  probeSummaries: Record<string, ProbeMonitorSummary>
  compactedStateStr: string | null
}
export type PublicDashboard = Omit<
  PublicDashboardSnapshot,
  'version' | 'generatedAt' | 'complete'
> & {
  snapshotAt: number | null
  snapshotIncomplete: boolean
  stale: boolean
  source: 'kv' | 'd1' | 'recovery'
}
