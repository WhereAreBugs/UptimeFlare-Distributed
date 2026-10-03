/** Version 1 wire protocol shared with the standalone Go probe. Times are Unix seconds. */
export type ProbeDefinition = {
  id: string
  /** Optional administrator override; empty means automatic IP geography + ASN. */
  name?: string
  location?: string
  /** Derived display defaults, never saved as administrator overrides. */
  defaultName?: string
  defaultLocation?: string
}
export type ProbeStage = 'dns' | 'tcp' | 'tls' | 'http' | 'body' | 'configuration' | 'unknown'
export type ProbeResult = {
  monitor_id: string
  time: number
  up: boolean
  latency_ms: number
  stage?: ProbeStage
  code?: string
  message?: string
}
export type ProbeBatch = { version: 1; batch_id: string; results: ProbeResult[] }
export type ProbeHistoryBucket = {
  time: number
  checks: number
  failures: number
  avgLatencyMs: number | null
}
export type ProbeFailure = { time: number; stage: string; code: string; message: string }
export type ProbeSummary = {
  id: string
  name: string
  location?: string
  status: 'up' | 'down' | 'unknown'
  stale: boolean
  latest: number | null
  latencyMs: number | null
  stage?: string
  code?: string
  message?: string
  checks: number
  failures: number
  avgLatencyMs: number | null
  failureStages: Record<string, number>
  history: ProbeHistoryBucket[]
  recentFailures: ProbeFailure[]
}
export type ProbeMonitorSummary = {
  monitorId: string
  status: 'up' | 'degraded' | 'down' | 'unknown'
  up: number
  down: number
  unknown: number
  total: number
  latest: number | null
  probes: ProbeSummary[]
}
