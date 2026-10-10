import { beforeAll, beforeEach, afterAll, expect, it, vi } from 'vitest'
import { Miniflare } from 'miniflare'
import { readFileSync } from 'node:fs'
import type { MonitorTarget, WorkerConfig } from '../../types/config'
import { getProbeDashboardSummaries, getProbeSummaries, type ProbeEnv } from '../src/probes'
import { handlePublicHistoryRequest } from '../src/history'
import { CompactedMonitorStateWrapper, getPublicNativeState, setToStore } from '../src/store'
import { runNotifications } from '../src/notifications'

const NOW = Math.floor(Date.now() / 1000)
let mf: Miniflare, env: ProbeEnv
const targets: MonitorTarget[] = Array.from({ length: 74 }, (_, i) => ({
  id: `target-${i}`,
  name: `Service ${i}`,
  method: 'GET',
  target: `https://private-target-${i}.example/secret`,
  headers: { Authorization: 'private-target-header' },
  probes: ['a', 'b', 'cloudflare'],
  paused: i >= 50,
}))
const config: WorkerConfig = {
  monitors: targets,
  probes: [
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B' },
  ],
}
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
  env = { UPTIMEFLARE_D1: (await mf.getD1Database('UPTIMEFLARE_D1')) as unknown as D1Database }
  for (const sql of readFileSync(new URL('../../init.sql', import.meta.url), 'utf8')
    .split(';')
    .filter((value) => value.trim()))
    await env.UPTIMEFLARE_D1.prepare(sql).run()
}, 30000)
beforeEach(async () => {
  vi.unstubAllGlobals()
  await env.UPTIMEFLARE_D1.batch(
    [
      'probe_latest',
      'probe_totals',
      'probe_buckets',
      'probe_days',
      'probe_samples',
      'probe_stage_totals',
      'probe_sample_details',
      'uptimeflare',
    ].map((table) => env.UPTIMEFLARE_D1.prepare(`DELETE FROM ${table}`))
  )
})
afterAll(async () => {
  vi.unstubAllGlobals()
  await mf?.dispose()
})
it('coalesces concurrent public history reads, caches only successes and checks pause/range before serving a cached result', async () => {
  await seed()
  const saved = new Map<string, Response>()
  vi.stubGlobal('caches', {
    default: {
      match: async (key: string) => saved.get(key)?.clone(),
      put: async (key: string, value: Response) => {
        saved.set(key, value.clone())
      },
    },
  })
  const trace = traced()
  const request = () => new Request('https://status.test/api/history?id=target-0')
  const responses = await Promise.all(
    Array.from({ length: 10 }, () => handlePublicHistoryRequest(request(), trace.env, config))
  )
  expect(responses.every((response) => response.status === 200)).toBe(true)
  expect(responses[0].headers.get('Cache-Control')).toBe('private,max-age=30')
  const count = trace.queries.length
  expect(count).toBeGreaterThan(0)
  expect(saved.size).toBe(1)
  expect(Array.from(saved.values())[0].headers.get('Cache-Control')).toBe('public,max-age=60')
  await handlePublicHistoryRequest(request(), trace.env, config)
  expect(trace.queries).toHaveLength(count)
  const paused = { ...config, monitors: [{ ...targets[0], paused: true }] }
  expect((await handlePublicHistoryRequest(request(), trace.env, paused)).status).toBe(404)
  expect(
    (
      await handlePublicHistoryRequest(
        new Request('https://status.test/api/history?id=target-0&from=0'),
        trace.env,
        config
      )
    ).status
  ).toBe(400)
  expect(trace.queries).toHaveLength(count)
  await handlePublicHistoryRequest(
    new Request(`https://status.test/api/history?id=target-0&from=${NOW - 300}&to=${NOW}`),
    trace.env,
    config
  )
  expect(trace.queries.length).toBeGreaterThan(count)
  expect(saved.size).toBe(2)
})
function traced() {
  const queries: string[] = []
  const batches: number[] = []
  let rows = 0
  const scoped = {
    ...env,
    UPTIMEFLARE_D1: new Proxy(env.UPTIMEFLARE_D1, {
      get(target, property) {
        if (property === 'prepare')
          return (sql: string) => {
            queries.push(sql)
            return target.prepare(sql)
          }
        if (property === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            batches.push(statements.length)
            const result = await target.batch(statements)
            rows += result.reduce((sum, item) => sum + (item.results?.length ?? 0), 0)
            return result
          }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }),
  }
  return {
    env: scoped,
    queries,
    batches,
    get rows() {
      return rows
    },
  }
}
async function seed() {
  const pairs = JSON.stringify(
    targets.flatMap((monitor) => monitor.probes!.map((probe) => ({ monitor: monitor.id, probe })))
  )
  await env.UPTIMEFLARE_D1.batch([
    env.UPTIMEFLARE_D1.prepare(
      "INSERT INTO probe_latest SELECT json_extract(value,'$.probe'),json_extract(value,'$.monitor'),?,1,12,'','','' FROM json_each(?)"
    ).bind(NOW, pairs),
    env.UPTIMEFLARE_D1.prepare(
      "INSERT INTO probe_totals SELECT json_extract(value,'$.probe'),json_extract(value,'$.monitor'),144,0,1728 FROM json_each(?)"
    ).bind(pairs),
    env.UPTIMEFLARE_D1.prepare(
      `WITH RECURSIVE ticks(i) AS(VALUES(0) UNION ALL SELECT i+1 FROM ticks WHERE i<143)
      INSERT INTO probe_buckets SELECT json_extract(p.value,'$.probe'),json_extract(p.value,'$.monitor'),?-i*300,1,0,12 FROM json_each(?) p CROSS JOIN ticks`
    ).bind(Math.floor(NOW / 300) * 300, pairs),
    env.UPTIMEFLARE_D1.prepare(
      "INSERT INTO probe_days SELECT json_extract(value,'$.probe'),json_extract(value,'$.monitor'),?,144,0,144,1728 FROM json_each(?)"
    ).bind(Math.floor(NOW / 86400) * 86400, pairs),
  ])
}
it('reads only active latest/totals with two queries, keeping real status/counts and explicitly unloaded history', async () => {
  await seed()
  const trace = traced()
  const result = await getProbeDashboardSummaries(trace.env, targets, config.probes, NOW)
  expect(Object.keys(result)).toHaveLength(50)
  expect(trace.batches).toEqual([2])
  expect(trace.rows).toBe(300)
  expect(trace.queries.join(' ')).not.toMatch(
    /FROM probe_buckets|FROM probe_days|FROM probe_samples|FROM probe_stage_totals/
  )
  expect(result['target-0']).toMatchObject({
    historyLoaded: false,
    status: 'up',
    up: 3,
    down: 0,
    unknown: 0,
    uptimePercent: 100,
    dailyHistory: [],
  })
  expect(result['target-0'].probes[0]).toMatchObject({
    checks: 144,
    failures: 0,
    history: [],
    dailyHistory: [],
    recentFailures: [],
    avgLatencyMs: null,
  })
  expect(result['target-50']).toBeUndefined()
  await env.UPTIMEFLARE_D1.prepare(
    "UPDATE probe_latest SET stage='body',code='timeout',message='Detailed failure history message' WHERE monitor_id='target-1' AND probe_id='a'"
  ).run()
  const compact = (await getProbeDashboardSummaries(env, [targets[1]], config.probes, NOW))[
    'target-1'
  ]
  expect(compact.probes[0].message).toBeUndefined()
  expect(compact.probes[0]).toMatchObject({ stage: 'body', code: 'timeout' })
  expect(
    (await getProbeSummaries(env, [targets[1]], config.probes, NOW))['target-1'].probes[0].message
  ).toBe('HTTP response body timed out')
  const full = (await getProbeSummaries(env, [targets[0]], config.probes, NOW))['target-0']
  expect(full).toMatchObject({ historyLoaded: true, status: 'up', up: 3, uptimePercent: 100 })
  expect(full.probes[0].history).toHaveLength(144)
  const baseline = await getProbeSummaries(
    env,
    targets.filter((target) => !target.paused),
    config.probes,
    NOW
  )
  const lightBytes = Buffer.byteLength(JSON.stringify(result))
  const fullBytes = Buffer.byteLength(JSON.stringify(baseline))
  expect(lightBytes).toBeLessThan(fullBytes / 10)
  console.log(
    JSON.stringify({
      fixtureTargets: 74,
      activeTargets: 50,
      latestAndTotalRows: trace.rows,
      dashboardQueries: 2,
      dashboardBytes: lightBytes,
      fullHistoryBytes: fullBytes,
    })
  )
}, 30000)
it('all paused and no active native return no summaries/state without touching D1', async () => {
  const untouched = {
    ...env,
    UPTIMEFLARE_D1: new Proxy(env.UPTIMEFLARE_D1, {
      get() {
        throw new Error('Paused dashboard must not read storage')
      },
    }),
  }
  expect(
    await getProbeDashboardSummaries(
      untouched,
      targets.map((target) => ({ ...target, paused: true })),
      config.probes,
      NOW
    )
  ).toEqual({})
  expect(await getPublicNativeState(untouched, targets)).toBeNull()
})
it('loads exactly one active target history, excludes paused/missing/invalid scope and never returns target configuration', async () => {
  await seed()
  const trace = traced()
  const response = await handlePublicHistoryRequest(
    new Request('https://status.test/api/history?id=target-1'),
    trace.env,
    config
  )
  expect(response.status).toBe(200)
  const data = (await response.json()) as any
  expect(data.monitorId).toBe('target-1')
  expect(data.summary.historyLoaded).toBe(true)
  expect(data.summary.probes).toHaveLength(3)
  expect(data.summary.probes[0].history).toHaveLength(144)
  expect(JSON.stringify(data)).not.toMatch(/private-target|Authorization|https:|headers/)
  expect(trace.batches).toEqual([6])
  expect(trace.rows).toBeLessThan(450)
  const before = trace.queries.length
  for (const query of [
    'id=target-50',
    'id=missing',
    'id=target-1&id=target-2',
    'id=target-1&token=secret',
    '',
  ]) {
    const response = await handlePublicHistoryRequest(
      new Request(`https://status.test/api/history?${query}`),
      trace.env,
      config
    )
    expect(response.status).toBe(query === 'id=target-50' || query === 'id=missing' ? 404 : 400)
  }
  expect(trace.queries).toHaveLength(before)
  expect(
    (
      await handlePublicHistoryRequest(
        new Request('https://status.test/api/history?id=target-1', { method: 'POST' }),
        env,
        config
      )
    ).status
  ).toBe(405)
})
it('projects native latest state and single-target retained history without off-scope or paused state', async () => {
  const state = new CompactedMonitorStateWrapper(null)
  for (const id of ['native', 'private-old', 'paused']) {
    state.appendLatency(id, { time: NOW - 300, ping: 4, loc: 'A' })
    state.appendLatency(id, { time: NOW, ping: 0, loc: 'B' })
    state.appendIncident(id, { start: [NOW - 1000], end: NOW - 800, error: ['dummy'] })
    state.appendIncident(id, {
      start: [NOW - 700, NOW - 500],
      end: null,
      error: ['[tcp/refused] prior', '[dns/lookup] latest'],
    })
  }
  await setToStore(env, 'state', state.getCompactedStateStr())
  const native = {
    id: 'native',
    name: 'Native',
    method: 'GET' as const,
    target: 'https://private-native.example',
  }
  const paused = { ...native, id: 'paused', paused: true }
  const latest = await getPublicNativeState(env, [native, paused])
  const decoded = new CompactedMonitorStateWrapper(latest).uncompact()
  expect(Object.keys(decoded.latency)).toEqual(['native'])
  expect(decoded.latency.native).toHaveLength(1)
  expect(decoded.incident.native).toHaveLength(1)
  expect(decoded.incident.native[0].error).toEqual(['[dns/lookup] latest'])
  const response = await handlePublicHistoryRequest(
    new Request('https://status.test/api/history?id=native'),
    env,
    { monitors: [native, paused] }
  )
  const data = (await response.json()) as any
  expect(data.historyLoaded).toBe(true)
  const history = new CompactedMonitorStateWrapper(data.compactedStateStr).uncompact()
  expect(Object.keys(history.latency)).toEqual(['native'])
  expect(history.latency.native).toHaveLength(2)
  expect(history.incident.native).toHaveLength(2)
  expect(data.compactedStateStr).not.toMatch(/private-old|paused/)
})
it('history storage failures return a safe retryable response', async () => {
  const broken = {
    ...env,
    UPTIMEFLARE_D1: new Proxy(env.UPTIMEFLARE_D1, {
      get() {
        throw new Error('private SQL and credential details')
      },
    }),
  }
  const response = await handlePublicHistoryRequest(
    new Request('https://status.test/api/history?id=target-1'),
    broken,
    config
  )
  expect(response.status).toBe(503)
  expect(await response.text()).not.toMatch(/SQL|credential/)
})
it('notification evaluation uses the same current state without querying historical buckets or failures', async () => {
  await seed()
  const trace = traced()
  const notify: WorkerConfig = {
    ...config,
    monitors: [{ ...targets[0], notificationTemplateId: 'notice' }],
    notificationTemplates: [
      {
        id: 'notice',
        name: 'Notice',
        type: 'webhook',
        webhook: {
          url: 'https://private-hook.example',
          payloadType: 'json',
          payload: { status: '$STATUS' },
        },
      },
    ],
  }
  await runNotifications(trace.env, notify, NOW, async () => new Response('ok'))
  expect(trace.queries.join(' ')).not.toMatch(
    /FROM probe_buckets|FROM probe_days|FROM probe_samples|FROM probe_stage_totals/
  )
  expect(
    await env.UPTIMEFLARE_D1.prepare(
      "SELECT status FROM notification_observations WHERE monitor_id='target-0'"
    ).first()
  ).toEqual({ status: 'up' })
})
