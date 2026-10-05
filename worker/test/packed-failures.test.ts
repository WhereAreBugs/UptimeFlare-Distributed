import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import { readFileSync } from 'node:fs'
import {
  cleanupProbeResults,
  getProbeIncidents,
  getProbeSummaries,
  persistBatch,
} from '../src/probes'
import {
  encodeFailureDocument,
  FAILURE_DAY,
  FAILURE_MARKER,
  FAILURE_PREFIX,
  MAX_FAILURE_BYTES,
  parseFailureDocument,
  preparePackedFailures,
  type FailureRow,
} from '../src/packed-failures'
import { measureDatabase, type ResourceCounts } from '../src/resources'
import type { Env } from '../src/index'
import type { WorkerConfig } from '../../types/config'
let mf: Miniflare, env: Env
const DAY = Math.floor(Date.now() / 86400000) * FAILURE_DAY - 2 * FAILURE_DAY
const NOW = DAY + 2 * FAILURE_DAY
const config: WorkerConfig & { revision: number } = {
  revision: 1,
  probes: [{ id: 'a' }, { id: 'b' }],
  monitors: ['web', 'other'].map((id) => ({
    id,
    name: id,
    method: 'GET',
    target: 'https://dummy.invalid',
    probes: ['a', 'b'],
  })),
}
const down = (time: number, monitor_id = 'web', stage = 'tcp', code = 'refused') => ({
  monitor_id,
  time,
  up: false,
  latency_ms: 5,
  stage,
  code,
})
const counters = (): ResourceCounts => ({
  sql: 0,
  rowsRead: 0,
  rowsWritten: 0,
  rowsReturned: 0,
  doRequests: 0,
  doDurationMs: 0,
})
const rows = () =>
  env.UPTIMEFLARE_D1.prepare(
    'SELECT * FROM probe_failure_events ORDER BY probe_id,monitor_id,time'
  ).all<FailureRow>()
async function pageAll(from = DAY, to = NOW + 1, limit = 17) {
  const events: any[] = []
  let cursor: string | undefined
  do {
    const page = await getProbeIncidents(
      env,
      config.monitors,
      config.probes,
      { from, to, limit, cursor },
      NOW
    )
    events.push(...page.failures)
    cursor = page.nextCursor ?? undefined
  } while (cursor)
  return events
}
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

it('merges a whole day of identical failures into one exact time run and never writes bucket stages', async () => {
  const samples = Array.from({ length: 288 }, (_, i) => down(DAY + 300 * i))
  await persistBatch(env, 'a', samples.slice(0, 200), [], undefined, 'first')
  await persistBatch(env, 'a', samples.slice(180), [], undefined, 'overlap')
  const stored = (await rows()).results
  expect(stored).toHaveLength(1)
  expect(parseFailureDocument(stored[0])).toMatchObject({
    count: 288,
    groups: [{ stage: 'tcp', code: 'refused', runs: [[0, 300, 288]] }],
  })
  expect(new TextEncoder().encode(stored[0].message).byteLength).toBeLessThan(256)
  expect(
    await env.UPTIMEFLARE_D1.prepare('SELECT COUNT(*) n FROM probe_bucket_stages').first('n')
  ).toBe(0)
  const events = await pageAll()
  expect(events.map((e) => e.time)).toEqual(samples.map((s) => s.time).reverse())
  expect(events.every((e) => e.monitorId === 'web' && e.probeId === 'a')).toBe(true)
  const summary = (await getProbeSummaries(env, config.monitors, config.probes, NOW)).web.probes[0]
  expect(summary).toMatchObject({ checks: 288, failures: 288, failureStages: { tcp: 288 } })
  expect(summary.recentFailures).toHaveLength(100)
  const replay = counters()
  await persistBatch(
    { ...env, UPTIMEFLARE_D1: measureDatabase(env.UPTIMEFLARE_D1, replay) },
    'a',
    samples.slice(0, 200),
    [],
    undefined,
    'first'
  )
  expect(replay.rowsWritten).toBe(0)
}, 30000)

it('preserves distinct causes, intermittent successes, irregular times, late uploads and mixed legacy pagination', async () => {
  for (const probe of ['a', 'b']) {
    await persistBatch(
      env,
      probe,
      [
        down(DAY + 302),
        down(DAY + 601, 'other', 'dns', 'not_found'),
        { monitor_id: 'web', time: DAY + 700, up: true, latency_ms: 10 },
        down(DAY + FAILURE_DAY + 1, 'web', 'tls', 'timeout'),
      ],
      [],
      undefined,
      probe + '-first'
    )
    await persistBatch(
      env,
      probe,
      [down(DAY + 1), down(DAY + 305, 'web', 'tcp', 'timeout')],
      [],
      undefined,
      probe + '-late'
    )
    await env.UPTIMEFLARE_D1.prepare('INSERT INTO probe_failure_events VALUES(?,?,?,?,?,?)')
      .bind(probe, 'web', DAY + 303, 'http', 'status', 'PRIVATE_OLD_MESSAGE')
      .run()
  }
  const events = await pageAll(DAY + 2, NOW, 1)
  expect(events).toHaveLength(10)
  expect(events.filter((e) => e.time === DAY + 303)).toHaveLength(2)
  expect(JSON.stringify(events)).not.toContain('PRIVATE_OLD_MESSAGE')
  expect(events.map((e) => [e.time, e.monitorId, e.probeId])).toEqual(
    [...events]
      .sort(
        (a, b) =>
          b.time - a.time ||
          (b.monitorId < a.monitorId
            ? -1
            : b.monitorId > a.monitorId
            ? 1
            : b.probeId < a.probeId
            ? -1
            : b.probeId > a.probeId
            ? 1
            : 0)
      )
      .map((e) => [e.time, e.monitorId, e.probeId])
  )
  const summary = (await getProbeSummaries(env, config.monitors, config.probes, NOW)).web.probes[0]
  expect(summary).toMatchObject({ checks: 5, failures: 4, failureStages: { tcp: 3, tls: 1 } })
  expect(summary.recentFailures.map((e) => e.time)).toEqual([
    DAY + FAILURE_DAY + 1,
    DAY + 305,
    DAY + 303,
    DAY + 302,
    DAY + 1,
  ])
})

it('bounds UTF8 chunks and paginates correctly when a late tail contains older samples', async () => {
  const samples = Array.from({ length: 45 }, (_, i) => ({
    ...down(DAY + 1000 + i),
    code: 'cause' + i,
    message: '中文'.repeat(400),
  }))
  await env.UPTIMEFLARE_D1.batch(await preparePackedFailures(env, 'a', samples, '1'))
  await env.UPTIMEFLARE_D1.batch(await preparePackedFailures(env, 'a', [down(DAY + 1)], '1'))
  const stored = (await rows()).results
  expect(stored.length).toBeGreaterThan(1)
  expect(
    stored.every((r) => new TextEncoder().encode(r.message).byteLength <= MAX_FAILURE_BYTES)
  ).toBe(true)
  expect(stored.reduce((n, r) => n + parseFailureDocument(r).count, 0)).toBe(46)
  const events = await pageAll(DAY, NOW, 7)
  expect(events.map((e) => e.time)).toEqual(
    [...samples.map((s) => s.time), DAY + 1].sort((a, b) => b - a)
  )
  expect(
    await getProbeIncidents(
      env,
      config.monitors,
      config.probes,
      { from: DAY + 1005, to: DAY + 1020, limit: 100 },
      NOW
    )
  ).toMatchObject({ nextCursor: null })
  expect((await pageAll(DAY + 1005, DAY + 1020, 2)).map((e) => e.time)).toEqual(
    Array.from({ length: 15 }, (_, i) => DAY + 1019 - i)
  )
})

it('rolls back raw history, counters and receipt when packed failure persistence aborts', async () => {
  await env.UPTIMEFLARE_D1.prepare(
    `CREATE TRIGGER abort_packed BEFORE INSERT ON probe_failure_events WHEN NEW.stage='${FAILURE_MARKER}' BEGIN SELECT RAISE(ABORT,'test failure'); END`
  ).run()
  try {
    await expect(persistBatch(env, 'a', [down(DAY)], [], undefined, 'aborted')).rejects.toThrow()
    for (const table of ['probe_result_blocks', 'probe_buckets', 'probe_latest', 'commit_runs'])
      expect(await env.UPTIMEFLARE_D1.prepare('SELECT COUNT(*) n FROM ' + table).first('n')).toBe(0)
    expect(
      await env.UPTIMEFLARE_D1.prepare(
        "SELECT value FROM uptimeflare WHERE key='probe-counters:v1:a'"
      ).first()
    ).toBeNull()
  } finally {
    await env.UPTIMEFLARE_D1.prepare('DROP TRIGGER abort_packed').run()
  }
})

it('rejects corrupt RLE and refuses ACK rather than losing previous observations', async () => {
  await persistBatch(env, 'a', [down(DAY)], [], undefined, 'good')
  await env.UPTIMEFLARE_D1.prepare('UPDATE probe_failure_events SET message=?')
    .bind(
      JSON.stringify({
        version: 1,
        count: 2,
        groups: [{ stage: 'tcp', code: 'refused', message: '', runs: [[0, 0, 2]] }],
      })
    )
    .run()
  await expect(persistBatch(env, 'a', [down(DAY + 300)], [], undefined, 'bad')).rejects.toThrow(
    'Invalid packed failure times'
  )
  expect(
    await env.UPTIMEFLARE_D1.prepare(
      "SELECT time FROM probe_latest WHERE probe_id='a' AND monitor_id='web'"
    ).first('time')
  ).toBe(DAY)
  await expect(pageAll()).rejects.toThrow('Invalid packed failure times')
})

it('expires stages exactly across a partial cutoff day and keeps documents until every bucket is drained', async () => {
  const cutoff = NOW - 90 * FAILURE_DAY + 450,
    oldDay = cutoff - 450
  await persistBatch(
    env,
    'a',
    [
      down(oldDay + 1),
      down(oldDay + 301, 'web', 'dns', 'timeout'),
      down(oldDay + 601, 'web', 'tls', 'timeout'),
    ],
    [],
    undefined,
    'old'
  )
  // Simulate a pre-optimization scalar event and its separate bucket-stage row.
  await env.UPTIMEFLARE_D1.batch([
    env.UPTIMEFLARE_D1.prepare("INSERT INTO probe_bucket_stages VALUES('a','web',?,'http',1)").bind(
      oldDay + 900
    ),
    env.UPTIMEFLARE_D1.prepare("INSERT INTO probe_buckets VALUES('a','web',?,1,1,5)").bind(
      oldDay + 900
    ),
    env.UPTIMEFLARE_D1.prepare(
      "INSERT INTO probe_failure_events VALUES('a','web',?,'http','status','legacy')"
    ).bind(oldDay + 901),
  ])
  const value = JSON.parse(
    (await env.UPTIMEFLARE_D1.prepare(
      "SELECT value FROM uptimeflare WHERE key='probe-counters:v1:a'"
    ).first('value')) as string
  )
  value.monitors.web.checks++
  value.monitors.web.failures++
  value.monitors.web.latency_sum += 5
  value.monitors.web.stages.http = 1
  await env.UPTIMEFLARE_D1.prepare("UPDATE uptimeflare SET value=? WHERE key='probe-counters:v1:a'")
    .bind(JSON.stringify(value))
    .run()
  await cleanupProbeResults(env, NOW + 450)
  let summary = (await getProbeSummaries(env, config.monitors, config.probes, NOW + 450)).web
    .probes[0]
  expect(summary).toMatchObject({ checks: 2, failures: 2, failureStages: { tls: 1, http: 1 } })
  expect((await rows()).results.some((r) => r.monitor_id === FAILURE_PREFIX + 'web')).toBe(true)
  await cleanupProbeResults(env, NOW + 2 * FAILURE_DAY)
  summary = (await getProbeSummaries(env, config.monitors, config.probes, NOW + 2 * FAILURE_DAY))
    .web.probes[0]
  expect(summary).toMatchObject({ checks: 0, failures: 0, failureStages: {} })
  await cleanupProbeResults(env, NOW + 2 * FAILURE_DAY + 3600)
  expect((await rows()).results).toHaveLength(0)
})

it('reads multiple chunk pages across sparse retained days without skipping failures', async () => {
  const times = Array.from({ length: 70 }, (_, i) => NOW - (i + 1) * FAILURE_DAY + 123)
  await env.UPTIMEFLARE_D1.batch(
    await preparePackedFailures(
      env,
      'a',
      times.map((time) => down(time)),
      '1'
    )
  )
  const page = await getProbeIncidents(
    env,
    config.monitors,
    config.probes,
    { from: NOW - 80 * FAILURE_DAY, limit: 100 },
    NOW
  )
  expect(page.failures.map((e) => e.time)).toEqual(times)
  expect(page.nextCursor).toBeNull()
})

it('bounds every SQL JSON argument when many target documents grow in the same batch', async () => {
  const samples = (start: number) =>
    Array.from({ length: 192 }, (_, i) => ({
      ...down(DAY + start + Math.floor(i / 24), 'monitor' + (i % 24)),
      code: 'cause' + (start + Math.floor(i / 24)),
      message: '中文'.repeat(200),
    }))
  await env.UPTIMEFLARE_D1.batch(await preparePackedFailures(env, 'a', samples(0), '1'))
  const statements = await preparePackedFailures(env, 'a', samples(100), '1')
  expect(statements.length).toBeGreaterThan(1)
  await env.UPTIMEFLARE_D1.batch(statements)
  expect(
    (await rows()).results.reduce((count, row) => count + parseFailureDocument(row).count, 0)
  ).toBe(384)
})
