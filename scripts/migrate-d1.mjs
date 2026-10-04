// Explicit operator tool. It is never loaded by the application or deployment workflow.
import { createRestDatabase } from '../deploy/d1-rest.mjs'
import { build } from '../worker/node_modules/esbuild/lib/main.js'
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, dirname } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
const args = process.argv.slice(2)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const option = (name) => {
  const at = args.indexOf(name)
  return at < 0 ? undefined : args[at + 1]
}
if (args.includes('--help') || !option('--plan')) {
  console.log(
    'node scripts/migrate-d1.mjs --plan private-plan.json --database-id UUID --dry-run\nApply: add --apply --writers-paused --backup NEW-FULL-BACKUP.sql and STATE_MIGRATION_APPROVED=1. Requires CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN. Every REST query is an independent request; no migration HTTP route is installed.'
  )
  process.exit(args.includes('--help') ? 0 : 1)
}
const databaseId = option('--database-id'),
  account = process.env.CLOUDFLARE_ACCOUNT_ID,
  token = process.env.CLOUDFLARE_API_TOKEN
const apply = args.includes('--apply'),
  dryRun = args.includes('--dry-run')
if (
  !databaseId ||
  !/^[a-f0-9-]{36}$/i.test(databaseId) ||
  !account ||
  !/^[a-f0-9]{32}$/i.test(account) ||
  !token ||
  apply === dryRun
)
  throw Error('Invalid migration arguments or credentials')
if (
  apply &&
  (process.env.STATE_MIGRATION_APPROVED !== '1' ||
    !args.includes('--writers-paused') ||
    !option('--backup'))
)
  throw Error('Apply requires explicit migration approval, paused producers and a new full backup')
if (statSync(option('--plan')).size > 16 * 1024 * 1024) throw Error('Migration plan exceeds budget')
const plan = JSON.parse(readFileSync(option('--plan'), 'utf8'))
const temp = mkdtempSync(resolve(tmpdir(), 'uptimeflare-migrate-'))
chmodSync(temp, 0o700)
try {
  await build({
    entryPoints: [resolve(root, 'worker/src/migration-v2.ts')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    outfile: resolve(temp, 'migration.mjs'),
  })
  const { migrateD1StateV2 } = await import(pathToFileURL(resolve(temp, 'migration.mjs')))
  const endpoint = `https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${databaseId}/query`
  const database = createRestDatabase(endpoint, token)
  if (apply) {
    const backup = resolve(option('--backup'))
    try {
      statSync(backup)
      throw Error('Backup path already exists')
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    const config = resolve(temp, 'wrangler.json')
    writeFileSync(
      config,
      JSON.stringify({
        name: 'uptimeflare-offline-migration',
        account_id: account,
        d1_databases: [
          { binding: 'UPTIMEFLARE_D1', database_name: 'migration-source', database_id: databaseId },
        ],
      }),
      { mode: 0o600 }
    )
    const result = spawnSync(
      process.execPath,
      [
        resolve(root, 'node_modules/wrangler/bin/wrangler.js'),
        'd1',
        'export',
        'UPTIMEFLARE_D1',
        '--remote',
        '--config',
        config,
        '--output',
        backup,
      ],
      { cwd: root, env: process.env, stdio: ['ignore', 'ignore', 'ignore'] }
    )
    if (result.status !== 0 || statSync(backup).size === 0)
      throw Error('Full D1 backup failed; migration has not started')
    chmodSync(backup, 0o600)
  }
  console.log(
    JSON.stringify(
      await migrateD1StateV2(
        { UPTIMEFLARE_D1: database, MIGRATION_MODE: apply ? '1' : '0' },
        plan,
        { dryRun }
      )
    )
  )
} finally {
  rmSync(temp, { recursive: true, force: true })
}
