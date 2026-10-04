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
export type ProbeStage =
  | 'dns'
  | 'tcp'
  | 'tls'
  | 'http'
  | 'body'
  | 'icmp'
  | 'proxy'
  | 'configuration'
  | 'unknown'
export type ProbeResult = {
  monitor_id: string
  time: number
  up: boolean
  latency_ms: number
  stage?: ProbeStage
  code?: string
  message?: string
  certificate_expires_at?: number
  certificate_days_remaining?: number
  icmp_latency_ms?: number
}
export type ProbeBatch = { version: 1; batch_id: string; results: ProbeResult[] }
export type ProbeHistoryBucket = {
  time: number
  checks: number
  failures: number
  avgLatencyMs: number | null
}
/** UTC daily totals. Uptime measures received checks; missing data is not a failure. */
export type ProbeDailyBucket = ProbeHistoryBucket & {
  uptimePercent: number | null
  /** Checks in wholly successful five-minute buckets, used for latency averaging. */
  latencyChecks: number
}
export type ProbeFailure = { time: number; stage: string; code: string; message: string }
export type ProbeFailureRow = ProbeFailure & {
  monitorId: string
  monitorName: string
  probeId: string
  probeName: string
}
export type ProbeIncidentPage = {
  failures: ProbeFailureRow[]
  nextCursor: string | null
  from: number
  to: number
}
export type NativeIncidentRow = {
  monitorId: string
  monitorName: string
  start: number
  end: number | null
  continued: boolean
  stale: boolean
  reasons: ProbeFailure[]
}
export type NativeIncidentPage = {
  incidents: NativeIncidentRow[]
  nextCursor: string | null
  from: number
  to: number
}
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
  certificateExpiresAt?: number
  certificateDaysRemaining?: number
  icmpLatencyMs?: number
  checks: number
  failures: number
  avgLatencyMs: number | null
  failureStages: Record<string, number>
  history: ProbeHistoryBucket[]
  dailyHistory: ProbeDailyBucket[]
  uptimePercent: number | null
  retainedFrom: number | null
  recentFailures: ProbeFailure[]
}
export type ProbeMonitorSummary = {
  monitorId: string
  /** Older public responses omit this field; omission means active. */
  paused?: boolean
  status: 'up' | 'degraded' | 'down' | 'unknown' | 'paused'
  up: number
  down: number
  unknown: number
  total: number
  latest: number | null
  dailyHistory: ProbeDailyBucket[]
  uptimePercent: number | null
  retainedFrom: number | null
  probes: ProbeSummary[]
}
