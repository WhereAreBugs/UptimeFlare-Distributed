import { afterAll, beforeAll, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { persistBatch, getProbeSummaries } from '../src/probes'
import { measureDatabase, type ResourceCounts } from '../src/resources'
import type { Env } from '../src/index'
import type { WorkerConfig } from '../../types/config'
let mf: Miniflare, db: D1Database
const DAY = Math.floor(Date.now() / 86400000) * 86400 - 86400
const config: WorkerConfig & { revision: number } = {
  revision: 1,
  probes: [{ id: 'a' }],
  monitors: Array.from({ length: 16 }, (_, i) => ({
    id: 'target' + i,
    name: 'Target ' + i,
    method: 'GET',
    target: 'https://dummy.invalid',
    probes: ['a'],
  })),
}
beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: '2025-04-02',
    d1Databases: ['UPTIMEFLARE_D1'],
  })
  db = (await mf.getD1Database('UPTIMEFLARE_D1')) as unknown as D1Database
  for (const sql of readFileSync(new URL('../../init.sql', import.meta.url), 'utf8')
    .split(';')
    .filter((s) => s.trim()))
    await db.prepare(sql).run()
}, 30000)
afterAll(async () => {
  await mf?.dispose()
})
it('measures successful and failed five-minute batches with identical configuration and verifies complete counts', async () => {
  const report: Record<string, ResourceCounts> = {}
  for (const [scenario, up] of [
    ['all-success', true],
    ['all-failure', false],
  ] as const) {
    const tables = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"
      )
      .all<{ name: string }>()
    for (const row of tables.results) await db.prepare('DELETE FROM ' + row.name).run()
    await db
      .prepare('INSERT INTO admin_config VALUES(1,1,?,?)')
      .bind(JSON.stringify(config), DAY)
      .run()
    const counts: ResourceCounts = {
      sql: 0,
      rowsRead: 0,
      rowsWritten: 0,
      rowsReturned: 0,
      doRequests: 0,
      doDurationMs: 0,
    }
    const env = {
      UPTIMEFLARE_D1: measureDatabase(db, counts),
      STATE_STORAGE_VERSION: '2',
      PACKED_PROBE_COUNTERS: '1',
    } as Env
    const samples = Array.from({ length: 200 }, (_, i) => ({
      monitor_id: 'target' + (i % 16),
      time: DAY + Math.floor(i / 16) * 300,
      up,
      latency_ms: 5,
      ...(!up && { stage: 'tcp', code: 'refused' }),
    }))
    await persistBatch(env, 'a', samples, [], undefined, scenario)
    report[scenario] = { ...counts }
    const summary = await getProbeSummaries(
      { UPTIMEFLARE_D1: db, STATE_STORAGE_VERSION: '2' },
      config.monitors,
      config.probes,
      DAY + 7200
    )
    expect(Object.values(summary).reduce((sum, m) => sum + m.probes[0].checks, 0)).toBe(200)
    expect(Object.values(summary).reduce((sum, m) => sum + m.probes[0].failures, 0)).toBe(
      up ? 0 : 200
    )
    expect(
      Object.values(summary).reduce((sum, m) => sum + m.probes[0].recentFailures.length, 0)
    ).toBe(up ? 0 : 200)
  }
  if (!process.env.D1_BASELINE_RUN)
    expect(report['all-failure'].rowsWritten - report['all-success'].rowsWritten).toBe(32)
  mkdirSync(new URL('../../.deployment/', import.meta.url), { recursive: true })
  writeFileSync(
    new URL('../../.deployment/failure-row-budget.json', import.meta.url),
    JSON.stringify(report, null, 2)
  )
}, 30000)
