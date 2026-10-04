import { beforeAll, afterAll, beforeEach, it, expect } from 'vitest'
import { Miniflare } from 'miniflare'
import { readFileSync } from 'node:fs'
import { migrateD1StateV2, type MigrationPlan } from '../src/migration-v2'
import type { ProbeEnv } from '../src/probes'
let mf: Miniflare, env: ProbeEnv & { MIGRATION_MODE: string }
let plan: MigrationPlan
beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: '2025-04-02',
    d1Databases: ['UPTIMEFLARE_D1'],
  })
  env = { UPTIMEFLARE_D1: await mf.getD1Database('UPTIMEFLARE_D1'), MIGRATION_MODE: '1' }
  for (const sql of readFileSync(new URL('../../init.sql', import.meta.url), 'utf8')
    .split(';')
    .filter((s) => s.trim()))
    await env.UPTIMEFLARE_D1.prepare(sql).run()
}, 30000)
afterAll(async () => {
  await mf?.dispose()
})
beforeEach(async () => {
  for (const table of [
    'uptimeflare',
    'storage_versions',
    'migration_runs',
    'native_hot',
    'native_incidents',
    'native_incident_reasons',
    'native_latency_blocks',
    'probe_result_blocks',
    'probe_failure_events',
    'probe_samples',
    'probe_sample_details',
    'commit_leases',
    'monitor_schedule',
  ])
    await env.UPTIMEFLARE_D1.prepare('DELETE FROM ' + table).run()
  const sourceValue = JSON.stringify({
    lastUpdate: 600,
    incident: {
      web: [
        { start: [300], end: 300, error: ['dummy'] },
        { start: [450, 500], end: null, error: ['tcp failure', 'dns failure'] },
      ],
    },
    latency: {
      web: [
        { time: 300, ping: 1, loc: 'SIN' },
        { time: 600, ping: 0, loc: 'SIN' },
      ],
    },
  })
  const sourceHash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(sourceValue))),
    (b) => b.toString(16).padStart(2, '0')
  ).join('')
  const sample = {
    monitor_id: 'web',
    time: 600,
    up: false,
    latency_ms: 5,
    stage: 'tcp',
    code: 'refused',
    message: 'PRIVATE_RAW_MESSAGE',
    certificate_days_remaining: 9,
  }
  plan = {
    version: 2,
    sourceValue,
    sourceHash,
    tables: {
      native_hot: [['web', 600, 0, 0, 'SIN', 'dns failure', 450, 300, 0]],
      native_incidents: [['web', 450, null]],
      native_incident_reasons: [
        ['web', 450, 450, 'tcp failure'],
        ['web', 450, 500, 'dns failure'],
      ],
      native_latency_blocks: [
        ['web', 300, JSON.stringify([{ time: 300, ping: 1, loc: 'SIN' }])],
        ['web', 600, JSON.stringify([{ time: 600, ping: 0, loc: 'SIN' }])],
      ],
      probe_result_blocks: [['a', 600, 0, JSON.stringify([sample])]],
      probe_failure_events: [['a', 'web', 600, 'tcp', 'refused', 'PRIVATE_RAW_MESSAGE']],
    },
  }
  await env.UPTIMEFLARE_D1.prepare("INSERT INTO uptimeflare VALUES('state',?)")
    .bind(sourceValue)
    .run()
  await env.UPTIMEFLARE_D1.prepare(
    "INSERT INTO probe_samples VALUES('a','web',600,0,5,'tcp','refused','PRIVATE_RAW_MESSAGE')"
  ).run()
  await env.UPTIMEFLARE_D1.prepare("INSERT INTO probe_sample_details VALUES('a','web',600,?)")
    .bind(JSON.stringify({ certificateDaysRemaining: 9 }))
    .run()
})
it('dry run does not write, activation preserves full values and idempotent rerun verifies identity', async () => {
  expect(await migrateD1StateV2(env, plan, { dryRun: true })).toMatchObject({ dryRun: true })
  expect(await env.UPTIMEFLARE_D1.prepare('SELECT 1 FROM native_hot').first()).toBeNull()
  expect(await migrateD1StateV2(env, plan)).toEqual({ migrated: true })
  expect(await migrateD1StateV2(env, plan)).toEqual({ alreadyMigrated: true })
  expect(
    (await env.UPTIMEFLARE_D1.prepare('SELECT value FROM probe_result_blocks').first<any>()).value
  ).toBe(plan.tables.probe_result_blocks[0][3])
  expect(
    (await env.UPTIMEFLARE_D1.prepare('SELECT lease_until FROM migration_runs').first<any>())
      .lease_until
  ).toBe(0)
})
it('partial failure never activates and an identical retry converges', async () => {
  await expect(
    migrateD1StateV2(env, plan, {
      afterBatch: async (i) => {
        if (i === 2) throw new Error('injected')
      },
    })
  ).rejects.toThrow('injected')
  expect(
    await env.UPTIMEFLARE_D1.prepare('SELECT version FROM storage_versions').first()
  ).toBeNull()
  expect(await migrateD1StateV2(env, plan)).toEqual({ migrated: true })
})
it('lease expiry/steal fences writes and activation; retry can recover', async () => {
  await expect(
    migrateD1StateV2(env, plan, {
      afterBatch: async () => {
        await env.UPTIMEFLARE_D1.prepare('UPDATE migration_runs SET lease_until=0').run()
      },
    })
  ).rejects.toThrow('lease lost')
  expect(
    await env.UPTIMEFLARE_D1.prepare('SELECT version FROM storage_versions').first()
  ).toBeNull()
  expect(await migrateD1StateV2(env, plan)).toEqual({ migrated: true })
})
it('rejects drift, forged values, malformed RLE and unsupported versions before writes', async () => {
  const bad = structuredClone(plan)
  bad.tables.native_hot[0][3] = 999
  await expect(migrateD1StateV2(env, bad)).rejects.toThrow('semantics')
  const probe = structuredClone(plan)
  const samples = JSON.parse(probe.tables.probe_result_blocks[0][3] as string)
  samples[0].certificate_days_remaining = 99
  probe.tables.probe_result_blocks[0][3] = JSON.stringify(samples)
  await expect(migrateD1StateV2(env, probe)).rejects.toThrow('semantics')
  await env.UPTIMEFLARE_D1.prepare("UPDATE uptimeflare SET value='{}'").run()
  await expect(migrateD1StateV2(env, plan)).rejects.toThrow('source drift')
  await env.UPTIMEFLARE_D1.prepare('INSERT INTO storage_versions VALUES(1,99,0)').run()
  await expect(migrateD1StateV2(env, plan)).rejects.toThrow('Unsupported')
})
it('operator REST adapter uses Cloudflare batch shape and the same guarded D1 conversion', async () => {
  // @ts-expect-error Operator module is deliberately outside the deployed TypeScript Worker.
  const { createRestDatabase } = await import('../../deploy/d1-rest.mjs')
  let requests = 0,
    batches = 0
  const database = createRestDatabase(
    'https://api.dummy.invalid/query',
    'dummy',
    async (_url: string, init: RequestInit) => {
      requests++
      const payload = JSON.parse(init.body as string)
      expect(Array.isArray(payload)).toBe(false)
      const statements = (payload.batch ?? [payload]).map(
        (item: { sql: string; params: unknown[] }) =>
          env.UPTIMEFLARE_D1.prepare(item.sql).bind(...item.params)
      )
      if (payload.batch) batches++
      return Response.json({ success: true, result: await env.UPTIMEFLARE_D1.batch(statements) })
    }
  )
  expect(await migrateD1StateV2({ ...env, UPTIMEFLARE_D1: database }, plan)).toEqual({
    migrated: true,
  })
  expect(requests).toBeGreaterThan(20)
  expect(batches).toBeGreaterThan(1)
})
