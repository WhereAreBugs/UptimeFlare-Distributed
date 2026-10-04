import type { MonitorState } from '../types/config'
import type { ProbeMonitorSummary } from '../types/probes'
import { PUBLIC_SNAPSHOT_MAX_AGE_SECONDS, type PublicDashboard } from '../types/public-dashboard'

export type PublicSnapshotMetadata = {
  snapshotAt?: number | null
  stale?: boolean
  snapshotIncomplete?: boolean
  source?: PublicDashboard['source']
}

export function isPublicSnapshotUnavailable(
  snapshot: PublicSnapshotMetadata,
  now = Math.floor(Date.now() / 1000)
) {
  return !!(
    snapshot.stale ||
    snapshot.snapshotIncomplete ||
    ((snapshot.source === 'kv' || snapshot.source === 'recovery') &&
      (!snapshot.snapshotAt ||
        !Number.isFinite(snapshot.snapshotAt) ||
        now - snapshot.snapshotAt > PUBLIC_SNAPSHOT_MAX_AGE_SECONDS))
  )
}

/** Preserve historical measurements and lifecycle, but never infer current health from an unavailable snapshot. */
export function guardPublicSnapshot(
  state: MonitorState,
  summaries: Record<string, ProbeMonitorSummary>,
  unavailable: boolean
) {
  if (!unavailable) return { state, summaries }
  return {
    state: { ...state, latency: {}, incident: {} },
    summaries: Object.fromEntries(
      Object.entries(summaries).map(([id, summary]) => {
        if (summary.paused || summary.status === 'paused') return [id, summary]
        const probes = summary.probes.map((probe) => ({
          ...probe,
          status: 'unknown' as const,
          stale: true,
        }))
        return [
          id,
          {
            ...summary,
            probes,
            status: 'unknown' as const,
            up: 0,
            down: 0,
            unknown: summary.total,
          },
        ]
      })
    ),
  }
}
