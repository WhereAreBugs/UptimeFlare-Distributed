import { afterAll, beforeAll, it, expect } from 'vitest'
import { Miniflare } from 'miniflare'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { persistBatch, getProbeSummaries } from '../src/probes'
import { runNativeMonitors } from '../src/native-monitor'
import { runNotifications } from '../src/notifications'
import { measureDatabase, type ResourceCounts } from '../src/resources'
import type { Env } from '../src/index'
import type { WorkerConfig } from '../../types/config'
let mf: Miniflare, db: D1Database
const now = Math.floor(Date.now() / 60000) * 60
beforeAll(async () => {
  const Bytes = Uint8Array as any
  Bytes.fromHex ??= (value: string) => Uint8Array.from(Buffer.from(value, 'hex'))
  Bytes.prototype.toHex ??= function () {
    return Buffer.from(this).toString('hex')
  }
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
const zero = (): ResourceCounts => ({
  sql: 0,
  rowsRead: 0,
  rowsWritten: 0,
  rowsReturned: 0,
  doRequests: 0,
  doDurationMs: 0,
})
it('uses point lookups for legacy latest updates despite unrelated cold history', async () => {
  await db.prepare('DELETE FROM probe_samples').run()
  await db.prepare('DELETE FROM probe_latest').run()
  await db
    .prepare(
      `WITH RECURSIVE n(i) AS (VALUES(1) UNION ALL SELECT i+1 FROM n WHERE i<5000)
    INSERT INTO probe_samples(probe_id,monitor_id,time,up,latency_ms,stage,code,message)
    SELECT 'compat','cold',?-86400+i,1,10,'','','' FROM n`
    )
    .bind(now)
    .run()
  const counts = zero()
  const results = Array.from({ length: 30 }, (_, i) => ({
    monitor_id: 'compat-hot-' + i,
    time: now,
    up: true,
    latency_ms: 12.5,
  }))
  await persistBatch(
    { UPTIMEFLARE_D1: measureDatabase(db, counts), STATE_STORAGE_VERSION: '1' },
    'compat',
    results
  )
  expect(counts.rowsRead).toBeLessThan(1500)
  const latest = await db
    .prepare("SELECT time,latency_ms FROM probe_latest WHERE probe_id='compat'")
    .all()
  expect(latest.results).toHaveLength(30)
  expect(latest.results.every((row) => row.time === now && row.latency_ms === 12.5)).toBe(true)
  mkdirSync(new URL('../../.deployment/', import.meta.url), { recursive: true })
  writeFileSync(
    new URL('../../.deployment/legacy-lookup-regression.json', import.meta.url),
    JSON.stringify({ coldSamples: 5000, submittedSamples: 30, ...counts }, null, 2)
  )
}, 30000)
it('compares identical stable, outage, timeout, notification and backlog workloads using actual D1 metadata', async () => {
  const report: any = {
    local: true,
    production: false,
    cpuMs: null,
    cpuNote:
      'Local workerd exposes D1 metadata and wall time; production CPU requires Cloudflare telemetry',
    scenarios: [],
  }
  for (const version of ['1', '2']) {
    const tables = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"
      )
      .all<{ name: string }>()
    for (const { name } of tables.results) await db.prepare('DELETE FROM ' + name).run()
    const config: WorkerConfig & { revision: number } = {
      revision: 1,
      probes: [{ id: 'a' }],
      monitors: Array.from({ length: 30 }, (_, i) => ({
        id: 't' + i,
        name: 'Target ' + i,
        method: 'GET',
        target: 'https://dummy.invalid',
        probes: ['a'],
        intervalSeconds: 60,
        notificationTemplateId: i === 0 ? 'notice' : undefined,
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
      .bind(JSON.stringify(config), now)
      .run()
    for (const [scenario, time, up, stage] of [
      ['stable', now, true, ''],
      ['outage', now + 60, false, 'tcp'],
      ['timeout', now + 120, false, 'body'],
      ['notification-recovery', now + 180, true, ''],
      ['backlog', now - 600, true, ''],
    ] as const) {
      const counts = zero(),
        env = { UPTIMEFLARE_D1: measureDatabase(db, counts), STATE_STORAGE_VERSION: version } as Env
      const results = Array.from({ length: scenario === 'backlog' ? 200 : 30 }, (_, i) => ({
        monitor_id: 't' + (i % 30),
        time: time + Math.floor(i / 30),
        up,
        latency_ms: up ? 10 + (i % 30) : 0,
        ...(stage && { stage, code: stage === 'body' ? 'timeout' : 'refused' }),
      }))
      const start = performance.now()
      await persistBatch(env, 'a', results, [], undefined, scenario)
      await runNotifications(
        env,
        config,
        time,
        async () => new Response(null, { status: 204 }),
        false
      )
      const wallDurationMs = performance.now() - start
      const summary = await getProbeSummaries(
        { UPTIMEFLARE_D1: db, STATE_STORAGE_VERSION: version },
        config.monitors,
        config.probes,
        now + 200
      )
      expect(summary.t0.probes[0].latest).toBe(scenario === 'backlog' ? now + 180 : time)
      report.scenarios.push({
        version,
        scenario,
        samples: results.length,
        ...counts,
        wallDurationMs,
      })
    }
    const nativeConfig = {
      ...config,
      monitors: config.monitors.map((m) => ({ ...m, probes: undefined })),
    }
    await db.prepare('UPDATE admin_config SET value=?').bind(JSON.stringify(nativeConfig)).run()
    for (const [scenario, time, up] of [
      ['native-stable', now, true],
      ['native-failure', now + 60, false],
      ['native-recovery', now + 120, true],
    ] as const) {
      const counts = zero(),
        env = {
          UPTIMEFLARE_D1: measureDatabase(db, counts),
          STATE_STORAGE_VERSION: version,
        } as Env,
        start = performance.now()
      await runNativeMonitors(env, nativeConfig, time, 'SIN', async (m) => ({
        id: m.id,
        location: 'SIN',
        status: { up, ping: up ? 10 : 0, err: up ? '' : '[tcp/refused] Refused' },
      }))
      report.scenarios.push({
        version,
        scenario,
        ...counts,
        wallDurationMs: performance.now() - start,
      })
    }
  }
  mkdirSync(new URL('../../.deployment/', import.meta.url), { recursive: true })
  writeFileSync(
    new URL('../../.deployment/local-resources.json', import.meta.url),
    JSON.stringify(report, null, 2)
  )
  const before = report.scenarios.find((s: any) => s.version === '1' && s.scenario === 'backlog'),
    after = report.scenarios.find((s: any) => s.version === '2' && s.scenario === 'backlog')
  expect(after.rowsWritten).toBeLessThan(before.rowsWritten)
}, 60000)
it('bounds SQL for 200 notified native targets, 200 probe windows and 500 notification evaluations', async () => {
  const tables = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"
    )
    .all<{ name: string }>()
  for (const { name } of tables.results) await db.prepare('DELETE FROM ' + name).run()
  const config: WorkerConfig & { revision: number } = {
    revision: 1,
    probes: [{ id: 'a' }],
    monitors: Array.from({ length: 500 }, (_, i) => ({
      id: 'scale' + i,
      name: 'Scale ' + i,
      target: 'https://dummy.invalid',
      method: 'GET',
      notificationTemplateId: 'notice',
      intervalSeconds: 300,
    })),
    notificationTemplates: [
      {
        id: 'notice',
        name: 'Notice',
        type: 'webhook',
        webhook: {
          url: 'https://dummy.invalid/hook',
          payloadType: 'json',
          payload: { message: '$MSG' },
        },
      },
    ],
  }
  await db
    .prepare('INSERT INTO admin_config VALUES(1,1,?,?)')
    .bind(JSON.stringify(config), now)
    .run()
  const { createExecutionBudget } = await import('../src/execution-budget')
  const counts = zero(),
    env = { UPTIMEFLARE_D1: measureDatabase(db, counts), STATE_STORAGE_VERSION: '2' } as Env
  const budget = createExecutionBudget()
  budget.locations!.set('root', 200)
  await runNativeMonitors(
    env,
    config,
    now,
    'SIN',
    async (m) => ({
      id: m.id,
      location: 'SIN',
      status: { up: false, ping: 0, err: '[tcp/refused] Refused' },
    }),
    budget
  )
  expect(counts.sql).toBeLessThanOrEqual(35)
  expect((await db.prepare('SELECT COUNT(*) n FROM native_hot').first<{ n: number }>())!.n).toBe(
    200
  )
  const nativeCounts = { ...counts }
  Object.assign(counts, zero())
  const probes = { ...config, monitors: config.monitors.map((m) => ({ ...m, probes: ['a'] })) }
  await db.prepare('UPDATE admin_config SET value=?').bind(JSON.stringify(probes)).run()
  await persistBatch(
    env,
    'a',
    Array.from({ length: 200 }, (_, i) => ({
      monitor_id: 'scale' + i,
      time: now - i * 300,
      up: false,
      latency_ms: 0,
      stage: 'tcp',
      code: 'refused',
    })),
    [],
    undefined,
    'scale-windows'
  )
  expect(counts.sql).toBeLessThanOrEqual(35)
  const probeCounts = { ...counts }
  Object.assign(counts, zero())
  await runNotifications(env, probes, now, undefined, false)
  expect(counts.sql).toBeLessThanOrEqual(35)
  const report = JSON.parse(
    readFileSync(new URL('../../.deployment/local-resources.json', import.meta.url), 'utf8')
  )
  report.capacity = {
    native200: nativeCounts,
    probe200Windows: probeCounts,
    notification500: { ...counts },
  }
  writeFileSync(
    new URL('../../.deployment/local-resources.json', import.meta.url),
    JSON.stringify(report, null, 2)
  )
}, 60000)
