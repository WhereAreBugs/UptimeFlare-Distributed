/** Management API timestamps are Unix seconds. Credentials never appear in list/status responses. */
export type ManagementPermission = 'query' | 'control'
export type ManagementGroup = { id: string; name: string; targetCount: number }
export type ManagementTokenEntry = {
  id: string
  name: string
  groupIds: string[]
  groupNames?: string[]
  permissions: ManagementPermission[]
  createdAt: number
  expiresAt: number | null
  revokedAt: number | null
}
export type ManagementTokenList = {
  groups: ManagementGroup[]
  tokens: ManagementTokenEntry[]
  configRevision: number
}
export type CreateManagementToken = {
  name: string
  groupIds: string[]
  permissions?: ManagementPermission[]
  expiresAt?: number | null
}
export type ManagementTokenCreated = { token: string; entry: ManagementTokenEntry }
export type ManagementMonitorStatus = {
  id: string
  name: string
  paused: boolean
  status: 'up' | 'down' | 'degraded' | 'unknown' | 'paused' | 'maintenance'
  up: boolean | null
  latest: number | null
  latencyMs: number | null
  reachableProbes: number | null
  unreachableProbes: number | null
  unknownProbes: number | null
}
export type ManagementStatus = {
  configRevision: number
  updatedAt: number | null
  monitors: ManagementMonitorStatus[]
}
