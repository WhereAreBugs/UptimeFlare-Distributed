import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeAssetRouting } from './asset-routing.mjs'

test('routing metadata uses the compiled source, protects password pages and contains no credential', async () => {
  const root = await mkdtemp(join(tmpdir(), 'asset-routing-'))
  try {
    await mkdir(join(root, 'out'))
    for (const [password, protectedPage] of [
      ['', false],
      ['private-fixture-password', true],
    ]) {
      await writeFile(
        join(root, 'uptime.config.ts'),
        `export const workerConfig = { passwordProtection: ${JSON.stringify(password)} };`
      )
      const value = await writeAssetRouting(root)
      assert.equal(value.protected, protectedPage)
      assert.match(value.sourceHash, /^[0-9a-f]{64}$/)
      const raw = await readFile(join(root, 'out/_worker-routing.json'), 'utf8')
      assert.ok(!raw.includes('private-fixture-password'))
      assert.deepEqual(Object.keys(value).sort(), ['protected', 'sourceHash'])
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
