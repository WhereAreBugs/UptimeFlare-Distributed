import { spawnSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const result = spawnSync(
  process.execPath,
  [
    resolve(root, 'node_modules/wrangler/bin/wrangler.js'),
    'deploy',
    '--dry-run',
    '--config',
    resolve(root, 'worker/wrangler.toml'),
    '--outdir',
    resolve(root, '.deployment/unified-worker'),
  ],
  { cwd: root, stdio: 'inherit' }
)
if (result.error) throw result.error
process.exitCode = result.status ?? 1
