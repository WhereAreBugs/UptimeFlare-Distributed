import type { ProbeEnv } from './probes'
import { validateMigrationSemantics } from './migration-validation'
export type MigrationPlan = {
  version: 2
  sourceValue: string | null
  sourceHash: string
  tables: Record<string, unknown[][]>
}
const schemas: Record<string, string[]> = {
  native_hot: [
    'monitor_id',
    'time',
    'up',
    'ping',
    'location',
    'error',
    'incident_start',
    'first_seen',
    'sequence',
  ],
  native_incidents: ['monitor_id', 'start', 'end'],
  native_incident_reasons: ['monitor_id', 'incident_start', 'time', 'error'],
  native_latency_blocks: ['monitor_id', 'window', 'value'],
  probe_result_blocks: ['probe_id', 'window', 'chunk', 'value'],
  probe_failure_events: ['probe_id', 'monitor_id', 'time', 'stage', 'code', 'message'],
}
async function hash(value: string) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    (b) => b.toString(16).padStart(2, '0')
  ).join('')
}
/** Only callable by deployment tooling with writers stopped; never exposed as an HTTP API. */
export async function migrateD1StateV2(
  env: ProbeEnv & { MIGRATION_MODE?: string },
  plan: MigrationPlan,
  options: { dryRun?: boolean; afterBatch?: (index: number) => Promise<void> } = {}
) {
  if (
    plan.version !== 2 ||
    Object.keys(plan.tables).some((name) => !schemas[name]) ||
    !Object.keys(schemas).every((name) => Array.isArray(plan.tables[name])) ||
    (await hash(plan.sourceValue ?? 'null')) !== plan.sourceHash
  )
    throw new Error('Invalid migration plan')
  for (const [name, rows] of Object.entries(plan.tables))
    for (const row of rows)
      if (!Array.isArray(row) || row.length !== schemas[name].length)
        throw new Error('Migration row shape mismatch')
  const version = await env.UPTIMEFLARE_D1.prepare(
    'SELECT version FROM storage_versions WHERE id=1'
  ).first<{ version: number }>()
  if (version && ![1, 2].includes(version.version)) throw new Error('Unsupported schema version')
  if (version?.version === 2) {
    const completed = await env.UPTIMEFLARE_D1.prepare(
      "SELECT source_hash,status FROM migration_runs WHERE name='state-v2'"
    ).first<{ source_hash: string; status: string }>()
    if (!completed || completed.status !== 'complete' || completed.source_hash !== plan.sourceHash)
      throw new Error('Unexplained migrated state')
    return { alreadyMigrated: true }
  }
  const stored = await env.UPTIMEFLARE_D1.prepare(
    "SELECT value FROM uptimeflare WHERE key='state'"
  ).first<{ value: string }>()
  if ((stored?.value ?? null) !== plan.sourceValue) throw new Error('Migration source drift')
  await validateMigrationSemantics(env, plan)
  if (options.dryRun)
    return {
      dryRun: true,
      rows: Object.values(plan.tables).reduce((n, rows) => n + rows.length, 0),
    }
  if (env.MIGRATION_MODE !== '1') throw new Error('Pause producers before migration')
  const active = await env.UPTIMEFLARE_D1.prepare(
    'SELECT 1 FROM monitor_schedule WHERE lease_until>unixepoch() UNION ALL SELECT 1 FROM commit_leases WHERE lease_until>unixepoch() LIMIT 1'
  ).first()
  if (active) throw new Error('Await outstanding writers before migration')
  const existing = await env.UPTIMEFLARE_D1.prepare(
    "SELECT source_hash,status FROM migration_runs WHERE name='state-v2'"
  ).first<{ source_hash: string; status: string }>()
  if (existing && existing.source_hash !== plan.sourceHash && existing.status !== 'rolledback')
    throw new Error('Partial migration source drift')
  if (!existing)
    for (const name of Object.keys(schemas))
      if (await env.UPTIMEFLARE_D1.prepare(`SELECT 1 FROM ${name} LIMIT 1`).first())
        throw new Error('Unexplained destination drift')
  const owner = crypto.randomUUID(),
    now = Math.floor(Date.now() / 1000)
  const claim = await env.UPTIMEFLARE_D1.prepare(
    "INSERT INTO migration_runs(name,owner,lease_until,source_hash,status,version) VALUES('state-v2',?,?,?,'running',2) ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,lease_until=excluded.lease_until,source_hash=excluded.source_hash,status='running' WHERE migration_runs.lease_until<=? AND (migration_runs.source_hash=excluded.source_hash OR migration_runs.status='rolledback') RETURNING owner"
  )
    .bind(owner, now + 60, plan.sourceHash, now)
    .first()
  if (!claim) throw new Error('Migration busy')
  const guard = `EXISTS(SELECT 1 FROM migration_runs WHERE name='state-v2' AND owner='${owner}' AND lease_until>unixepoch() AND status='running')`
  const renew = async () => {
    const value = await env.UPTIMEFLARE_D1.prepare(
      `UPDATE migration_runs SET lease_until=unixepoch()+60 WHERE ${guard}`
    ).run()
    if (!value.meta.changes) throw new Error('Migration lease lost')
  }
  try {
    await env.UPTIMEFLARE_D1.batch(
      Object.keys(schemas).map((table) =>
        env.UPTIMEFLARE_D1.prepare(`DELETE FROM ${table} WHERE (${guard})`)
      )
    )
    let index = 0
    for (const [table, columns] of Object.entries(schemas)) {
      for (let offset = 0; offset < plan.tables[table].length; offset += 128) {
        await renew()
        const rows = plan.tables[table].slice(offset, offset + 128),
          payload = JSON.stringify(rows)
        if (new TextEncoder().encode(payload).byteLength > 1024 * 1024)
          throw new Error('Migration batch byte budget exceeded')
        const result = await env.UPTIMEFLARE_D1.prepare(
          `INSERT OR REPLACE INTO ${table}(${columns.join(',')}) SELECT ${columns
            .map((_, i) => `json_extract(value,'$[${i}]')`)
            .join(',')} FROM json_each(?) WHERE (${guard})`
        )
          .bind(payload)
          .run()
        if (!result.success || result.meta.changes !== rows.length)
          throw new Error('Migration write not confirmed')
        await options.afterBatch?.(++index)
      }
      const persisted = await env.UPTIMEFLARE_D1.prepare(
        `SELECT ${columns.join(',')} FROM ${table}`
      ).raw<unknown[]>()
      const normalize = (rows: unknown[][]) => rows.map((row) => JSON.stringify(row)).sort()
      if (JSON.stringify(normalize(persisted)) !== JSON.stringify(normalize(plan.tables[table])))
        throw new Error('Migration semantic comparison failed')
    }
    const source = await env.UPTIMEFLARE_D1.prepare(
      "SELECT value FROM uptimeflare WHERE key='state'"
    ).first<{ value: string }>()
    if ((source?.value ?? null) !== plan.sourceValue)
      throw new Error('Migration source changed before activation')
    await renew()
    const activated = await env.UPTIMEFLARE_D1.batch([
      env.UPTIMEFLARE_D1.prepare(
        `INSERT INTO storage_versions(id,version,migrated_at) SELECT 1,2,unixepoch() WHERE (${guard}) ON CONFLICT(id) DO UPDATE SET version=2,migrated_at=excluded.migrated_at`
      ),
      env.UPTIMEFLARE_D1.prepare(
        `UPDATE migration_runs SET status='complete',lease_until=0 WHERE (${guard})`
      ),
    ])
    if (activated.some((r) => !r.success) || !activated[0].meta.changes)
      throw new Error('Migration activation failed')
    return { migrated: true }
  } finally {
    await env.UPTIMEFLARE_D1.prepare(
      "UPDATE migration_runs SET lease_until=0 WHERE name='state-v2' AND owner=?"
    )
      .bind(owner)
      .run()
  }
}
