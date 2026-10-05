import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import {
  cleanupProbeResults,
  getProbeSummaries,
  handleProbeRequest,
  MAX_PROBE_BODY,
  preflightProbeRequest,
} from '../src/probes'
import type { MonitorTarget } from '../../types/config'
import type { ProbeEnv } from '../src/probes'

const TOKEN_A = 'independent-probe-a-secret-123456'
const TOKEN_B = 'independent-probe-b-secret-123456'
const NOW = Math.floor(Date.now() / 1000)
const monitors: MonitorTarget[] = [
  {
    id: 'web',
    name: 'Web',
    method: 'GET',
    target: 'https://example.com',
    probes: ['a', 'b'],
    headers: { 'X-Value': 42 },
  },
  { id: 'private', name: 'Private', method: 'TCP_PING', target: 'localhost:80', probes: ['b'] },
  { id: 'native', name: 'Native', method: 'GET', target: 'https://example.com' },
]
let mf: Miniflare
let env: ProbeEnv
let batchNumber = 0
function sample(time = NOW, up = true, monitor = 'web') {
  return {
    monitor_id: monitor,
    time,
    up,
    latency_ms: 12.5,
    ...(up ? {} : { stage: 'dns', code: 'dns_not_found', message: 'No DNS answer' }),
  }
}
function batch(results = [sample()]) {
  return { version: 1, batch_id: (++batchNumber).toString(16).padStart(64, '0'), results }
}
async function ingest(value: unknown, token = TOKEN_A, encoding?: string) {
  const body = typeof value === 'string' ? value : JSON.stringify(value)
  return handleProbeRequest(
    new Request('https://status.test/api/probes/ingest', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...(encoding && { 'Content-Encoding': encoding }),
      },
      body: encoding === 'gzip' ? gzipSync(body) : body,
    }),
    env,
    monitors
  )
}
async function count(table: string) {
  return (await env.UPTIMEFLARE_D1.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{
    n: number
  }>())!.n
}

beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: '2025-04-02',
    d1Databases: ['UPTIMEFLARE_D1'],
  })
  env = {
    UPTIMEFLARE_D1: (await mf.getD1Database('UPTIMEFLARE_D1')) as unknown as D1Database,
    PROBE_TOKENS: JSON.stringify({ a: TOKEN_A, b: TOKEN_B }),
  }
  const schema =
    readFileSync(new URL('../../migrations/0001_external_probes.sql', import.meta.url), 'utf8') +
    readFileSync(new URL('../../migrations/0006_probe_history.sql', import.meta.url), 'utf8')
  for (const statement of schema.split(';').filter((s) => s.trim()))
    await env.UPTIMEFLARE_D1.prepare(statement).run()
}, 30000)
afterAll(async () => {
  await mf?.dispose()
})

describe('authenticated probe contract', () => {
  it('authenticates method/path/credentials before any settings/database access, including missing D1', async () => {
    let reads = 0
    const guarded = {
      PROBE_TOKENS: JSON.stringify({ a: TOKEN_A }),
      UPTIMEFLARE_D1: {
        prepare() {
          reads++
          throw new Error('D1 must not be read')
        },
      },
    } as unknown as ProbeEnv
    for (const [path, method] of [
      ['/api/probes/config', 'GET'],
      ['/api/probes/ingest', 'POST'],
    ]) {
      const request = new Request(`https://status.test${path}`, { method })
      expect(preflightProbeRequest(request, guarded)?.status).toBe(401)
      expect((await handleProbeRequest(request, guarded, monitors)).status).toBe(401)
    }
    expect(
      preflightProbeRequest(
        new Request('https://status.test/api/probes/config', { method: 'POST' }),
        guarded
      )?.status
    ).toBe(405)
    expect(preflightProbeRequest(new Request('https://status.test/unknown'), guarded)?.status).toBe(
      404
    )
    expect(
      preflightProbeRequest(new Request('https://status.test/api/probes/config'), {
        ...guarded,
        PROBE_TOKENS: '{bad',
      })?.status
    ).toBe(503)
    expect(
      preflightProbeRequest(
        new Request('https://status.test/api/probes/config', {
          headers: { Authorization: `Bearer ${TOKEN_A}` },
        }),
        guarded
      )
    ).toBeNull()
    expect(reads).toBe(0)
  })
  it('returns only assigned targets and millisecond timeouts, converting headers to strings', async () => {
    const response = await handleProbeRequest(
      new Request('https://status.test/api/probes/config', {
        headers: { Authorization: `Bearer ${TOKEN_A}` },
      }),
      env,
      monitors
    )
    expect(response.status).toBe(200)
    const config = (await response.json()) as any
    expect(config).toMatchObject({
      version: 1,
      probe_id: 'a',
      monitors: [{ id: 'web', intervalSeconds: 300, timeout: 5000, headers: { 'X-Value': '42' } }],
    })
    expect(config.monitors).toHaveLength(1)
    expect(JSON.stringify(config)).not.toContain(TOKEN_A)
  })
  it('rejects absent and wrong credentials, unsupported routes, and wrong methods', async () => {
    expect((await ingest(batch(), 'incorrect')).status).toBe(401)
    expect(
      (
        await handleProbeRequest(
          new Request('https://status.test/api/probes/config'),
          env,
          monitors
        )
      ).status
    ).toBe(401)
    expect(
      (
        await handleProbeRequest(
          new Request('https://status.test/api/probes/config/other'),
          env,
          monitors
        )
      ).status
    ).toBe(404)
    expect(
      (
        await handleProbeRequest(
          new Request('https://status.test/api/probes/ingest'),
          env,
          monitors
        )
      ).status
    ).toBe(405)
  })

  it('provides safe names and paused assignments for the local dashboard without status storage', async () => {
    const response = await handleProbeRequest(
      new Request('https://status.test/api/probes/config', {
        headers: { Authorization: `Bearer ${TOKEN_A}` },
      }),
      env,
      [
        ...monitors,
        {
          id: 'paused',
          name: 'Paused target',
          method: 'GET',
          target: 'https://private.test',
          paused: true,
          probes: ['a'],
          headers: { Authorization: 'private-request-secret' },
          body: 'private-body',
        },
      ],
      undefined,
      [{ id: 'a', name: 'Friendly name', location: 'Example ASN' }]
    )
    const config = (await response.json()) as any
    expect(config.probe).toEqual({ name: 'Friendly name', location: 'Example ASN' })
    expect(config.monitors.map((m: any) => m.id)).not.toContain('paused')
    expect(config.display_monitors.map((m: any) => m.name)).toEqual(['Web', 'Paused target'])
    expect(config.display_monitors[1]).toMatchObject({
      paused: true,
      intervalSeconds: 300,
      timeout: 5000,
    })
    expect(JSON.stringify(config.display_monitors)).not.toContain('private-request-secret')
    expect(JSON.stringify(config.display_monitors)).not.toContain('private.test')
    expect(JSON.stringify(config)).not.toContain('private-body')
    expect(
      preflightProbeRequest(
        new Request('https://status.test/api/probes/status', { method: 'POST' }),
        env
      )?.status
    ).toBe(404)
  })
  it('fails closed for malformed token registries and duplicated secrets', async () => {
    for (const value of [
      'invalid',
      '[]',
      JSON.stringify({ a: TOKEN_A, b: TOKEN_A }),
      JSON.stringify({ a: 'short' }),
    ]) {
      expect(
        (
          await handleProbeRequest(
            new Request('https://status.test/api/probes/config', {
              headers: { Authorization: `Bearer ${TOKEN_A}` },
            }),
            { ...env, PROBE_TOKENS: value },
            monitors
          )
        ).status
      ).toBe(503)
    }
  })
  it('validates the whole batch before any write, including ownership', async () => {
    const before = await count('probe_samples')
    expect((await ingest(batch([sample(NOW - 1), sample(NOW - 2, true, 'private')]))).status).toBe(
      403
    )
    expect(await count('probe_samples')).toBe(before)
  })
  it('rejects invalid timestamps, identity, diagnostics, latency, and duplicates', async () => {
    for (const result of [
      { ...sample(), time: NOW + 1000 },
      { ...sample(), time: 1 },
      { ...sample(), time: 1.5 },
      { ...sample(), latency_ms: -1 },
      { ...sample(), latency_ms: 300001 },
      { ...sample(), up: 'true' },
      { ...sample(), monitor_id: '../web' },
      { ...sample(NOW, false), stage: 'incorrect' },
      { ...sample(NOW, false), stage: undefined },
      { ...sample(), message: 'x'.repeat(513) },
    ])
      expect((await ingest(batch([result] as any))).status).toBe(400)
    expect((await ingest(batch([sample(), sample()]))).status).toBe(400)
    expect(
      (await ingest(batch(Array.from({ length: 201 }, (_, n) => sample(NOW - n))))).status
    ).toBe(400)
    expect((await ingest({ ...batch(), batch_id: 'invalid' })).status).toBe(400)
  })
  it('bounds compressed and decoded bodies, rejects invalid encodings and malformed gzip', async () => {
    expect((await ingest('x'.repeat(MAX_PROBE_BODY + 1))).status).toBe(413)
    expect((await ingest('x'.repeat(MAX_PROBE_BODY + 1), TOKEN_A, 'gzip')).status).toBe(413)
    expect((await ingest(batch(), TOKEN_A, 'br')).status).toBe(415)
    expect((await ingest('{')).status).toBe(400)
    expect(
      (
        await handleProbeRequest(
          new Request('https://status.test/api/probes/ingest', {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${TOKEN_A}`,
              'Content-Type': 'application/json',
              'Content-Encoding': 'gzip',
            },
            body: 'not gzip',
          }),
          env,
          monitors
        )
      ).status
    ).toBe(400)
  })
})

describe('durable, idempotent and ordered ingestion', () => {
  it('ACKs a gzip batch only after persistence and deduplicates a lost-ACK replay', async () => {
    const data = batch([sample(NOW - 300, false), sample(NOW - 240)])
    const response = await ingest(data, TOKEN_A, 'gzip')
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ batch_id: data.batch_id, accepted: 2 })
    const before = await count('probe_samples')
    expect((await ingest(data)).status).toBe(200)
    expect(await count('probe_samples')).toBe(before)
    const stats = await getProbeSummaries(env, monitors, [], NOW)
    expect(stats.web.probes[0]).toMatchObject({ checks: 2, failures: 1, failureStages: { dns: 1 } })
  })
  it('never regresses latest from reordered backlogs or conflicting replay', async () => {
    expect((await ingest(batch([sample(NOW - 120)]))).status).toBe(200)
    expect((await ingest(batch([sample(NOW - 180, false)]))).status).toBe(200)
    expect((await ingest(batch([sample(NOW - 120, false)]))).status).toBe(200)
    const latest = await env.UPTIMEFLARE_D1.prepare(
      'SELECT * FROM probe_latest WHERE probe_id=? AND monitor_id=?'
    )
      .bind('a', 'web')
      .first<any>()
    expect(latest).toMatchObject({ time: NOW - 120, up: 1 })
    const stats = (await getProbeSummaries(env, monitors, [], NOW)).web.probes[0]
    expect(stats).toMatchObject({ checks: 4, failures: 2, failureStages: { dns: 2 } })
    expect(stats.history.reduce((sum, b) => sum + b.checks, 0)).toBe(4)
  })
  it('persists 200 samples in one atomic batch with accurate five-minute rollups', async () => {
    const data = batch(
      Array.from({ length: 200 }, (_, n) => sample(NOW - 600 - n, n % 3 !== 0, 'private'))
    )
    expect((await ingest(data, TOKEN_B)).status).toBe(200)
    expect((await ingest(data, TOKEN_B)).status).toBe(200)
    const stats = (await getProbeSummaries(env, monitors, [], NOW)).private.probes[0]
    expect(stats.checks).toBe(200)
    expect(stats.failures).toBe(67)
    expect(stats.avgLatencyMs).toBeNull() // Both five-minute buckets contain failures.
    expect(stats.recentFailures).toHaveLength(67)
  })
  it('rolls back all writes when a later D1 statement fails', async () => {
    const before = await count('probe_samples')
    const latest = await env.UPTIMEFLARE_D1.prepare(
      'SELECT time FROM probe_latest WHERE probe_id=? AND monitor_id=?'
    )
      .bind('a', 'web')
      .first<any>()
    const totals = await env.UPTIMEFLARE_D1.prepare(
      'SELECT * FROM probe_totals WHERE probe_id=? AND monitor_id=?'
    )
      .bind('a', 'web')
      .first<any>()
    await env.UPTIMEFLARE_D1.prepare(
      "CREATE TRIGGER test_abort_stage BEFORE INSERT ON probe_bucket_stages BEGIN SELECT RAISE(ABORT,'test transaction rollback'); END"
    ).run()
    try {
      expect((await ingest(batch([sample(NOW - 100, false)]))).status).toBe(503)
      expect(await count('probe_samples')).toBe(before)
      expect(
        await env.UPTIMEFLARE_D1.prepare(
          'SELECT time FROM probe_latest WHERE probe_id=? AND monitor_id=?'
        )
          .bind('a', 'web')
          .first<any>()
      ).toEqual(latest)
      expect(
        await env.UPTIMEFLARE_D1.prepare(
          'SELECT * FROM probe_totals WHERE probe_id=? AND monitor_id=?'
        )
          .bind('a', 'web')
          .first<any>()
      ).toEqual(totals)
    } finally {
      await env.UPTIMEFLARE_D1.prepare('DROP TRIGGER test_abort_stage').run()
    }
  })
  it('does not ACK when persistence fails', async () => {
    const failing = {
      ...env,
      UPTIMEFLARE_D1: {
        prepare: env.UPTIMEFLARE_D1.prepare.bind(env.UPTIMEFLARE_D1),
        batch: async () => {
          throw new Error('unavailable')
        },
      } as unknown as D1Database,
    }
    const response = await handleProbeRequest(
      new Request('https://status.test/api/probes/ingest', {
        method: 'POST',
        headers: { Authorization: `Bearer ${TOKEN_A}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(batch([sample(NOW)])),
      }),
      failing,
      monitors
    )
    expect(response.status).toBe(503)
    expect(await response.text()).not.toContain('accepted')
  })
  it('retains missing probes as unknown without degrading reporting probes, and preserves mixed results', async () => {
    let stats = (
      await getProbeSummaries(env, monitors, [{ id: 'a', name: 'Singapore', location: 'SG' }], NOW)
    ).web
    expect(stats.status).toBe('up')
    expect(stats.unknown).toBe(1)
    expect(stats.probes[0]).toMatchObject({ name: 'Singapore', location: 'SG' })
    expect(stats.probes[1]).toMatchObject({ status: 'unknown', stale: true, code: 'no_data' })
    expect((await ingest(batch([sample(NOW - 90, false)]))).status).toBe(200)
    stats = (await getProbeSummaries(env, monitors, [], NOW)).web
    expect(stats.status).toBe('down')
    expect(stats.unknown).toBe(1)
    expect((await ingest(batch([sample(NOW - 80)]))).status).toBe(200)
    expect((await ingest(batch([sample(NOW - 60)]), TOKEN_B)).status).toBe(200)
    stats = (await getProbeSummaries(env, monitors, [], NOW)).web
    expect(stats.status).toBe('up')
    expect((await ingest(batch([sample(NOW - 30, false)]), TOKEN_B)).status).toBe(200)
    expect((await getProbeSummaries(env, monitors, [], NOW)).web.status).toBe('degraded')
    expect((await ingest(batch([sample(NOW - 15, false)]))).status).toBe(200)
    expect((await getProbeSummaries(env, monitors, [], NOW)).web.status).toBe('down')
    stats = (await getProbeSummaries(env, monitors, [], NOW + 1000)).web
    expect(stats.status).toBe('unknown')
    expect(stats.probes.every((p) => p.stage === 'probe' && p.code === 'stale')).toBe(true)
  })
  it('accepts historical offline backlog, and cleans bounded expired rows without deleting latest', async () => {
    const totalsBefore = await env.UPTIMEFLARE_D1.prepare(
      'SELECT * FROM probe_totals WHERE probe_id=? AND monitor_id=?'
    )
      .bind('a', 'web')
      .first<any>()
    const stagesBefore = (
      await env.UPTIMEFLARE_D1.prepare(
        'SELECT * FROM probe_stage_totals WHERE probe_id=? AND monitor_id=?'
      )
        .bind('a', 'web')
        .all<any>()
    ).results
    expect((await ingest(batch([sample(NOW - 91 * 24 * 3600, false)]))).status).toBe(200)
    const before = await count('probe_samples')
    await cleanupProbeResults(env, NOW)
    expect(await count('probe_samples')).toBe(before - 1)
    expect(
      await env.UPTIMEFLARE_D1.prepare(
        'SELECT * FROM probe_totals WHERE probe_id=? AND monitor_id=?'
      )
        .bind('a', 'web')
        .first<any>()
    ).toEqual(totalsBefore)
    expect(
      (
        await env.UPTIMEFLARE_D1.prepare(
          'SELECT * FROM probe_stage_totals WHERE probe_id=? AND monitor_id=?'
        )
          .bind('a', 'web')
          .all<any>()
      ).results
    ).toEqual(stagesBefore)
    await cleanupProbeResults(env, NOW)
    expect(
      await env.UPTIMEFLARE_D1.prepare(
        'SELECT * FROM probe_totals WHERE probe_id=? AND monitor_id=?'
      )
        .bind('a', 'web')
        .first<any>()
    ).toEqual(totalsBefore)
    expect(
      (
        await env.UPTIMEFLARE_D1.prepare(
          'SELECT time FROM probe_latest WHERE probe_id=? AND monitor_id=?'
        )
          .bind('a', 'web')
          .first<any>()
      ).time
    ).toBe(NOW - 15)
  })
})
