import { afterAll, beforeAll, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { persistBatch, getProbeSummaries } from '../src/probes'
import { runNotifications } from '../src/notifications'
import { measureDatabase, type ResourceCounts } from '../src/resources'
import type { Env } from '../src/index'
import type { WorkerConfig } from '../../types/config'
let mf: Miniflare, db: D1Database
const NOW = Math.floor(Date.now() / 300000) * 300
const zero = (): ResourceCounts => ({
  sql: 0,
  rowsRead: 0,
  rowsWritten: 0,
  rowsReturned: 0,
  doRequests: 0,
  doDurationMs: 0,
})
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

it('bounds actual D1 rows with unrelated hot/cold data and preserves historical statistics', async () => {
  const config: WorkerConfig & { revision: number } = {
    revision: 1,
    probes: [{ id: 'a' }],
    monitors: Array.from({ length: 16 }, (_, i) => ({
      id: 't' + i,
      name: 'Target ' + i,
      method: 'GET',
      target: 'https://dummy.invalid',
      probes: ['a'],
      notificationTemplateId: 'notice',
    })),
    notificationTemplates: [
      {
        id: 'notice',
        name: 'Notice',
        type: 'webhook',
        webhook: {
          url: 'https://dummy.invalid/hook',
          payloadType: 'json',
          payload: { text: '$MSG' },
        },
      },
    ],
  }
  await db
    .prepare('INSERT INTO admin_config VALUES(1,1,?,?)')
    .bind(JSON.stringify(config), NOW)
    .run()
  await db
    .prepare(
      `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<10000) INSERT INTO probe_latest SELECT 'unused','cold'||i,?,1,10,'','','' FROM n`
    )
    .bind(NOW - 86400)
    .run()
  await db
    .prepare(
      `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<10000) INSERT INTO probe_buckets SELECT 'unused','cold'||i,?,1,0,10 FROM n`
    )
    .bind(NOW - 86400)
    .run()
  const report: Record<string, ResourceCounts> = {}
  let batches = 0
  for (const [scenario, start, spacing] of [
    ['historical', NOW - 3600, 1],
    ['fresh', NOW, 1],
    ['five-minute-backlog', NOW - 86400, 300],
  ] as const) {
    const counts = zero(),
      env = {
        UPTIMEFLARE_D1: measureDatabase(db, counts),
        STATE_STORAGE_VERSION: '2',
        PACKED_PROBE_COUNTERS: '1',
      } as Env
    const results = Array.from({ length: 200 }, (_, i) => ({
      monitor_id: 't' + (i % 16),
      time: start + Math.floor(i / 16) * spacing,
      up: i % 8 !== 0,
      latency_ms: i % 8 !== 0 ? i / 10 : 0,
      ...(i % 8 === 0 && {
        stage: 'tcp' as const,
        code: 'refused',
        message: 'TCP connection refused',
      }),
    }))
    await persistBatch(env, 'a', results, [], undefined, scenario)
    batches++
    report[scenario] = { ...counts }
    const summary = await getProbeSummaries(
      { UPTIMEFLARE_D1: db, STATE_STORAGE_VERSION: '2' },
      config.monitors,
      config.probes,
      NOW + 20
    )
    expect(Object.values(summary).reduce((sum, monitor) => sum + monitor.probes[0].checks, 0)).toBe(
      batches * 200
    )
    expect(
      Object.values(summary).reduce((sum, monitor) => sum + monitor.probes[0].failures, 0)
    ).toBe(batches * 25)
    const replay = zero()
    await persistBatch(
      { ...env, UPTIMEFLARE_D1: measureDatabase(db, replay) },
      'a',
      results,
      [],
      undefined,
      scenario
    )
    report[scenario + '-replay'] = replay
    expect(replay.rowsWritten).toBe(0)
  }
  const counts = zero()
  await runNotifications(
    { UPTIMEFLARE_D1: measureDatabase(db, counts), STATE_STORAGE_VERSION: '2' },
    config,
    NOW + 20,
    undefined,
    false
  )
  report.notification = counts
  mkdirSync(new URL('../../.deployment/', import.meta.url), { recursive: true })
  writeFileSync(
    new URL('../../.deployment/row-budget.json', import.meta.url),
    JSON.stringify(report, null, 2)
  )
  if (!process.env.D1_BASELINE_RUN) {
    expect(report.historical.rowsRead).toBeLessThan(256)
    expect(report.fresh.rowsRead).toBeLessThan(640)
    expect(report['five-minute-backlog'].rowsRead).toBeLessThan(2500)
    expect(report.notification.rowsRead).toBeLessThan(500)
  }
}, 30000)
