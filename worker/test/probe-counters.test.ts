import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import { readFileSync } from 'node:fs'
import { cleanupProbeResults, getProbeSummaries, persistBatch } from '../src/probes'
import { loadProbeCounters } from '../src/probe-counters'
import { measureDatabase, type ResourceCounts } from '../src/resources'
import type { Env } from '../src/index'
import type { WorkerConfig } from '../../types/config'
let mf: Miniflare, env: Env
const NOW = Math.floor(Date.now() / 300000) * 300
const config: WorkerConfig & { revision: number } = {
  revision: 1,
  monitors: [
    { id: 'web', name: 'Web', method: 'GET', target: 'https://dummy.invalid', probes: ['a'] },
  ],
  probes: [{ id: 'a' }],
}
const summary = async () =>
  (await getProbeSummaries(env, config.monitors, config.probes, NOW)).web.probes[0]
const down = (time: number) => ({
  monitor_id: 'web',
  time,
  up: false,
  latency_ms: 5,
  stage: 'tcp' as const,
  code: 'refused',
})
const counts = (): ResourceCounts => ({
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
  env = {
    UPTIMEFLARE_D1: await mf.getD1Database('UPTIMEFLARE_D1'),
    STATE_STORAGE_VERSION: '2',
    PACKED_PROBE_COUNTERS: '1',
  } as unknown as Env
  for (const sql of readFileSync(new URL('../../init.sql', import.meta.url), 'utf8')
    .split(';')
    .filter((s) => s.trim()))
    await env.UPTIMEFLARE_D1.prepare(sql).run()
}, 30000)
beforeEach(async () => {
  const tables = await env.UPTIMEFLARE_D1.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"
  ).all<{ name: string }>()
  for (const row of tables.results)
    await env.UPTIMEFLARE_D1.prepare('DELETE FROM ' + row.name).run()
  await env.UPTIMEFLARE_D1.prepare('INSERT INTO admin_config VALUES(1,1,?,?)')
    .bind(JSON.stringify(config), NOW)
    .run()
})
afterAll(async () => {
  await mf?.dispose()
})

it('hydrates legacy counters once, keeps them authoritative without the activation flag and deduplicates overlaps', async () => {
  await persistBatch(
    { ...env, PACKED_PROBE_COUNTERS: undefined },
    'a',
    [down(NOW - 10)],
    [],
    undefined,
    'legacy'
  )
  await persistBatch(
    env,
    'a',
    [{ monitor_id: 'web', time: NOW, up: true, latency_ms: 10 }],
    [],
    undefined,
    'packed'
  )
  expect(await summary()).toMatchObject({ checks: 2, failures: 1, failureStages: { tcp: 1 } })
  await persistBatch(
    { ...env, PACKED_PROBE_COUNTERS: undefined },
    'a',
    [down(NOW + 1)],
    [],
    undefined,
    'later'
  )
  await persistBatch(env, 'a', [down(NOW - 10), down(NOW + 1)], [], undefined, 'overlap')
  expect(await summary()).toMatchObject({ checks: 3, failures: 2, failureStages: { tcp: 2 } })
  expect(
    (await env.UPTIMEFLARE_D1.prepare("SELECT checks FROM probe_totals WHERE probe_id='a'").first<{
      checks: number
    }>())!.checks
  ).toBe(1)
  const replay = counts()
  await persistBatch(
    { ...env, UPTIMEFLARE_D1: measureDatabase(env.UPTIMEFLARE_D1, replay) },
    'a',
    [down(NOW + 1)],
    [],
    undefined,
    'later'
  )
  expect(replay.rowsWritten).toBe(0)
})

it('expires exactly the bounded buckets once, preserving fresh totals and stage statistics', async () => {
  await persistBatch(
    env,
    'a',
    [down(NOW - 91 * 86400), down(NOW - 91 * 86400 + 300), down(NOW)],
    [],
    undefined,
    'retention'
  )
  expect(await summary()).toMatchObject({ checks: 3, failures: 3, failureStages: { tcp: 3 } })
  await cleanupProbeResults(env, NOW)
  expect(await summary()).toMatchObject({ checks: 1, failures: 1, failureStages: { tcp: 1 } })
  await cleanupProbeResults(env, NOW + 30)
  expect(await summary()).toMatchObject({ checks: 1, failures: 1, failureStages: { tcp: 1 } })
})

it('keeps mixed packed and legacy probe counters isolated during expiration', async () => {
  await persistBatch(
    { ...env, PACKED_PROBE_COUNTERS: undefined },
    'a',
    [down(NOW - 91 * 86400)],
    [],
    undefined,
    'legacy-old'
  )
  await persistBatch(env, 'a', [down(NOW)], [], undefined, 'packed-new')
  await persistBatch(
    { ...env, PACKED_PROBE_COUNTERS: undefined },
    'b',
    [down(NOW - 91 * 86400), down(NOW)],
    [],
    undefined,
    'other-probe'
  )
  await cleanupProbeResults(env, NOW)
  expect(await summary()).toMatchObject({ checks: 1, failures: 1 })
  expect(
    (await env.UPTIMEFLARE_D1.prepare(
      "SELECT checks,failures FROM probe_totals WHERE probe_id='b'"
    ).first())!
  ).toMatchObject({ checks: 1, failures: 1 })
})

it('does not publish packed counters if a later statistics statement rolls back', async () => {
  await persistBatch(env, 'a', [down(NOW)], [], undefined, 'good')
  const before = JSON.stringify((await loadProbeCounters(env, ['a'])).get('a'))
  await env.UPTIMEFLARE_D1.prepare('DROP TABLE probe_failure_events').run()
  try {
    await expect(persistBatch(env, 'a', [down(NOW + 1)], [], undefined, 'failed')).rejects.toThrow()
    expect(JSON.stringify((await loadProbeCounters(env, ['a'])).get('a'))).toBe(before)
    expect(
      await env.UPTIMEFLARE_D1.prepare(
        "SELECT run_id FROM commit_runs WHERE run_id='probe:a:failed'"
      ).first()
    ).toBeNull()
  } finally {
    await env.UPTIMEFLARE_D1.prepare(
      readFileSync(new URL('../../init.sql', import.meta.url), 'utf8')
        .split(';')
        .find((s) => s.includes('CREATE TABLE IF NOT EXISTS probe_failure_events'))!
    ).run()
  }
})

it('rejects corrupted counter documents without silently falling back to frozen legacy rows', async () => {
  await env.UPTIMEFLARE_D1.prepare('INSERT INTO uptimeflare VALUES(?,?)')
    .bind(
      'probe-counters:v1:a',
      JSON.stringify({
        version: 1,
        monitors: { web: { checks: -1, failures: 0, latency_sum: 0, stages: {} } },
      })
    )
    .run()
  await expect(summary()).rejects.toThrow('Invalid probe counter document')
  await expect(persistBatch(env, 'a', [down(NOW)], [], undefined, 'invalid')).rejects.toThrow(
    'Invalid probe counter document'
  )
})
