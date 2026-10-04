import type { ProbeEnv } from './probes'
import type { WorkerConfig } from '../../types/config'
import { stableNotificationKey } from './notifications'

export type CommitLease = {
  owner: string
  guard: string
  runId: string
  hash: string
  replay: boolean
}
/** Acquire after measurement. A stable receipt answers retries after lost RPC/HTTP responses. */
export async function beginCommit(
  env: ProbeEnv,
  runId: string,
  payload: unknown,
  config: WorkerConfig
): Promise<CommitLease> {
  if (!/^[a-zA-Z0-9_.:-]{1,200}$/.test(runId)) throw new Error('Invalid commit identity')
  const hash = await stableNotificationKey(payload)
  const prior = await env.UPTIMEFLARE_D1.prepare(
    'SELECT payload_hash FROM commit_runs WHERE run_id=?'
  )
    .bind(runId)
    .first<{ payload_hash: string }>()
  if (prior) {
    if (prior.payload_hash !== hash) throw new Error('Conflicting commit replay')
    return { owner: '', guard: '0', runId, hash, replay: true }
  }
  const now = Math.floor(Date.now() / 1000),
    owner = crypto.randomUUID()
  const row = await env.UPTIMEFLARE_D1.prepare(
    `INSERT INTO commit_leases(scope,owner,lease_until) VALUES('state-v2',?,?) ON CONFLICT(scope) DO UPDATE SET owner=excluded.owner,lease_until=excluded.lease_until WHERE commit_leases.lease_until<=? RETURNING owner`
  )
    .bind(owner, now + 30, now)
    .first()
  if (!row) throw new Error('State commit busy; retry the same run')
  const revision = (config as WorkerConfig & { revision?: number }).revision ?? 0
  const guard = `EXISTS(SELECT 1 FROM commit_leases WHERE scope='state-v2' AND owner='${owner}' AND lease_until>unixepoch()) AND ${
    revision
      ? `EXISTS(SELECT 1 FROM admin_config WHERE id=1 AND revision=${revision})`
      : 'NOT EXISTS(SELECT 1 FROM admin_config WHERE id=1)'
  }`
  return { owner, guard, runId, hash, replay: false }
}
export async function endCommit(
  env: ProbeEnv,
  lease: CommitLease,
  statements: D1PreparedStatement[]
) {
  if (lease.replay) return true
  const receipt = env.UPTIMEFLARE_D1.prepare(
    `INSERT OR IGNORE INTO commit_runs(run_id,protocol,payload_hash,committed_at) SELECT ?,1,?,unixepoch() WHERE (${lease.guard})`
  ).bind(lease.runId, lease.hash)
  const results = await env.UPTIMEFLARE_D1.batch([receipt, ...statements])
  if (results.some((result) => !result.success)) throw new Error('State transaction failed')
  // Conditional zero rows means stale ownership/config, not a SQL transaction failure.
  return !!results[0].meta.changes
}
export async function releaseCommit(env: ProbeEnv, lease: CommitLease) {
  if (!lease.owner) return
  await env.UPTIMEFLARE_D1.prepare("DELETE FROM commit_leases WHERE scope='state-v2' AND owner=?")
    .bind(lease.owner)
    .run()
}
