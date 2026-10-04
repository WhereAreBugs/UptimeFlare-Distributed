import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import { readFileSync } from 'node:fs'
import {
  cleanupProbeResults,
  getProbeIncidents,
  getProbeSummaries,
  handleProbeRequest,
  persistBatch,
} from '../src/probes'
import { getNativeIncidents } from '../src/incident-history'
import { CompactedMonitorStateWrapper, setToStore } from '../src/store'
import type { ProbeEnv } from '../src/probes'
import type { ProbeResult } from '../../types/probes'
import type { MonitorTarget } from '../../types/config'

const NOW = Math.floor(Date.now() / 300000) * 300
const TOKEN = 'history-probe-token-fixture-1234567890'
const monitors: MonitorTarget[] = [
  {
    id: 'web',
    name: 'Public web',
    method: 'GET',
    target: 'https://private-target.example/token',
    headers: { Authorization: 'SECRET' },
    probes: ['a', 'b'],
  },
  {
    id: 'other',
    name: 'Other service',
    method: 'GET',
    target: 'https://private.example',
    probes: ['a'],
  },
  { id: 'native', name: 'Native service', method: 'GET', target: 'https://private.example' },
]
const row = (time: number, up = true, latency_ms = 20, monitor_id = 'web'): ProbeResult => ({
  monitor_id,
  time,
  up,
  latency_ms,
  ...(!up && { stage: 'tcp' as const, code: 'refused', message: 'TCP connection was refused' }),
})
let mf: Miniflare
let env: ProbeEnv
async function sqlFile(relative: string) {
  for (const sql of readFileSync(new URL(relative, import.meta.url), 'utf8')
    .split(';')
    .filter((sql) => sql.trim()))
    await env.UPTIMEFLARE_D1.prepare(sql).run()
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
  env = {
    UPTIMEFLARE_D1: (await mf.getD1Database('UPTIMEFLARE_D1')) as unknown as D1Database,
    PROBE_TOKENS: JSON.stringify({ a: TOKEN }),
  }
  await sqlFile('../../init.sql')
}, 30000)
beforeEach(async () => {
  for (const table of [
    'probe_sample_details',
    'probe_days',
    'probe_samples',
    'probe_latest',
    'probe_buckets',
    'probe_bucket_stages',
    'probe_totals',
    'probe_stage_totals',
    'uptimeflare',
  ])
    await env.UPTIMEFLARE_D1.prepare(`DELETE FROM ${table}`).run()
})
afterAll(async () => {
  await mf?.dispose()
})

describe('bounded retained history', () => {
  it('backfills old five-minute buckets idempotently and does not double count subsequent replay', async () => {
    const data = [row(NOW - 300), row(NOW - 240, false, 1000), row(NOW - 600, true, 10)]
    await persistBatch(env, 'a', data)
    await env.UPTIMEFLARE_D1.prepare('DELETE FROM probe_days').run()
    await sqlFile('../../migrations/0006_probe_history.sql')
    await sqlFile('../../migrations/0006_probe_history.sql')
    await persistBatch(env, 'a', data)
    const days = (await getProbeSummaries(env, monitors, [], NOW)).web.probes[0].dailyHistory
    expect(days.reduce((sum, day) => sum + day.checks, 0)).toBe(3)
    expect(days.reduce((sum, day) => sum + day.failures, 0)).toBe(1)
    expect(days.reduce((sum, day) => sum + day.latencyChecks, 0)).toBe(1)
    expect(days.find((day) => day.latencyChecks)!.avgLatencyMs).toBe(10)
  })
  it('breaks latency at failed/mixed buckets and reverses a formerly successful bucket contribution', async () => {
    await persistBatch(env, 'a', [row(NOW - 300, true, 20)])
    let summary = (await getProbeSummaries(env, monitors, [], NOW)).web.probes[0]
    expect(summary.avgLatencyMs).toBe(20)
    await persistBatch(env, 'a', [row(NOW - 240, false, 120000), row(NOW, true, 10)])
    summary = (await getProbeSummaries(env, monitors, [], NOW)).web.probes[0]
    expect(summary.history.find((bucket) => bucket.time === NOW - 300)!.avgLatencyMs).toBeNull()
    expect(summary.avgLatencyMs).toBe(10)
    expect(summary.uptimePercent).toBeCloseTo(200 / 3)
    await persistBatch(env, 'b', [row(NOW + 1, false, 90000)])
    const combined = (await getProbeSummaries(env, monitors, [], NOW + 1)).web
    expect(combined.probes[1].latencyMs).toBeNull()
    expect(combined.uptimePercent).toBe(50)
  })
  it('exposes ninety daily bars without reading raw samples for uptime and excludes absent probes', async () => {
    await persistBatch(env, 'a', [row(NOW - 89 * 86400), row(NOW - 20 * 86400, false), row(NOW)])
    const summary = (await getProbeSummaries(env, monitors, [], NOW)).web
    expect(summary.dailyHistory).toHaveLength(90)
    expect(summary.dailyHistory.filter((day) => day.uptimePercent !== null)).toHaveLength(3)
    expect(summary.probes[1].uptimePercent).toBeNull()
    expect(summary.uptimePercent).toBeCloseTo(200 / 3)
    expect(summary.status).toBe('up')
    const serialized = JSON.stringify(summary)
    expect(serialized).not.toContain('private-target')
    expect(serialized).not.toContain('SECRET')
  })
  it('cleans expired history and daily counters together while preserving the latest certificate metadata', async () => {
    const old = NOW - 91 * 86400
    await persistBatch(env, 'a', [
      { ...row(old), certificate_expires_at: NOW + 86400, certificate_days_remaining: 1 },
      row(old + 300, false),
    ])
    await persistBatch(env, 'b', [row(NOW)])
    await cleanupProbeResults(env, NOW)
    await cleanupProbeResults(env, NOW)
    expect(
      (await env.UPTIMEFLARE_D1.prepare('SELECT COUNT(*) n FROM probe_days WHERE time<?')
        .bind(NOW - 90 * 86400)
        .first<any>())!.n
    ).toBe(0)
    expect(
      (await env.UPTIMEFLARE_D1.prepare(
        'SELECT checks FROM probe_totals WHERE probe_id=? AND monitor_id=?'
      )
        .bind('a', 'web')
        .first<any>())!.checks
    ).toBe(0)
    expect((await getProbeSummaries(env, monitors, [], NOW)).web.probes[0].checks).toBe(0)
    expect(
      (await env.UPTIMEFLARE_D1.prepare(
        'SELECT COUNT(*) n FROM probe_sample_details'
      ).first<any>())!.n
    ).toBe(0)
    await persistBatch(env, 'a', [
      { ...row(NOW - 92 * 86400, true, 1, 'other'), certificate_expires_at: NOW + 86400 },
    ])
    await cleanupProbeResults(env, NOW)
    expect(
      (await getProbeSummaries(env, monitors, [], NOW)).other.probes[0].certificateExpiresAt
    ).toBe(NOW + 86400)
  })
  it('rolls back samples, metadata and daily rollups on any persistence failure', async () => {
    await env.UPTIMEFLARE_D1.prepare(
      "CREATE TRIGGER reject_day BEFORE INSERT ON probe_days BEGIN SELECT RAISE(ABORT,'fixture failure'); END"
    ).run()
    await expect(
      persistBatch(env, 'a', [{ ...row(NOW), certificate_expires_at: NOW + 86400 }])
    ).rejects.toThrow()
    await env.UPTIMEFLARE_D1.prepare('DROP TRIGGER reject_day').run()
    for (const table of ['probe_samples', 'probe_latest', 'probe_days', 'probe_sample_details'])
      expect(
        (await env.UPTIMEFLARE_D1.prepare(`SELECT COUNT(*) n FROM ${table}`).first<any>())!.n
      ).toBe(0)
  })
})

describe('complete ninety-day failed-check pagination', () => {
  it('traverses more than two hundred checks with tied timestamps without duplicates or omissions', async () => {
    const data = Array.from({ length: 180 }, (_, index) => row(NOW - index * 300, false))
    await persistBatch(env, 'a', data)
    await persistBatch(env, 'b', data)
    await persistBatch(env, 'a', [row(NOW - 89 * 86400, false), row(NOW - 91 * 86400, false)])
    let cursor: string | undefined
    const identities: string[] = []
    do {
      const page = await getProbeIncidents(
        env,
        monitors,
        [
          { id: 'a', name: 'Tokyo' },
          { id: 'b', name: 'Paris' },
        ],
        { cursor, limit: 73 },
        NOW
      )
      for (const failure of page.failures)
        identities.push(`${failure.monitorId}:${failure.probeId}:${failure.time}`)
      expect(JSON.stringify(page)).not.toContain('private-target')
      expect(JSON.stringify(page)).not.toContain('SECRET')
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    expect(identities).toHaveLength(361)
    expect(new Set(identities).size).toBe(361)
  })
  it('supports month, target and probe scope and rejects malformed cursors/oversized pages', async () => {
    await persistBatch(env, 'a', [row(NOW - 300, false), row(NOW - 600, false, 20, 'other')])
    await persistBatch(env, 'b', [row(NOW - 300, false)])
    const page = await getProbeIncidents(
      env,
      monitors,
      [],
      { monitorId: 'web', probeId: 'a', from: NOW - 400, to: NOW },
      NOW
    )
    expect(page.failures).toHaveLength(1)
    expect(page.failures[0]).toMatchObject({ monitorName: 'Public web', probeId: 'a' })
    for (const query of [
      { cursor: 'invalid' },
      { cursor: btoa(JSON.stringify([NOW - 300, null, null])) },
      { cursor: btoa(JSON.stringify([NOW, 'web', 'a', 'extra'])) },
      { limit: 101 },
      { monitorId: 'missing' },
      { probeId: 'not-assigned' },
      { from: NOW, to: NOW },
    ])
      await expect(getProbeIncidents(env, monitors, [], query, NOW)).rejects.toThrow()
  })
})

describe('optional certificate and ICMP metadata', () => {
  it('distributes SSL/ICMP/proxy settings only to assigned probes and validates source configuration', async () => {
    const targets: MonitorTarget[] = [
      {
        ...monitors[0],
        id: 'certificate',
        method: 'SSL_CERT',
        target: 'https://certificate-private.example',
        certificateExpiryDays: 0,
        checkProxy: 'https://assigned-proxy.example/check',
        checkProxyHeaders: { Authorization: 'assigned-proxy-token' },
        checkProxyFallback: false,
        notificationGracePeriodSeconds: 123,
        notificationTemplateId: 'private-template',
        probes: ['a'],
      },
      {
        ...monitors[0],
        id: 'icmp',
        method: 'ICMP_PING',
        target: '::1',
        icmpProxyURL: 'https://assigned-icmp.example/check',
        probes: ['a'],
      },
      {
        ...monitors[0],
        id: 'unassigned',
        method: 'SSL_CERT',
        target: 'https://unassigned.example',
        checkProxy: 'https://unassigned-proxy.example',
        checkProxyHeaders: { Authorization: 'unassigned-proxy-secret' },
        probes: ['b'],
      },
    ]
    const request = () =>
      new Request('https://test/api/probes/config', {
        headers: { Authorization: `Bearer ${TOKEN}` },
      })
    const response = await handleProbeRequest(request(), env, targets)
    expect(response.status).toBe(200)
    const value = (await response.json()) as any
    expect(value.monitors).toHaveLength(2)
    expect(value.monitors[0]).toMatchObject({
      method: 'SSL_CERT',
      certificateExpiryDays: 0,
      checkProxyHeaders: { Authorization: 'assigned-proxy-token' },
      checkProxyFallback: false,
    })
    expect(value.monitors[1]).toMatchObject({
      method: 'ICMP_PING',
      target: '::1',
      icmpProxyURL: 'https://assigned-icmp.example/check',
    })
    const encoded = JSON.stringify(value)
    for (const secret of [
      'unassigned.example',
      'unassigned-proxy',
      'private-template',
      'notificationGracePeriodSeconds',
    ])
      expect(encoded).not.toContain(secret)
    for (const invalid of [
      { method: 'SSL_CERT', target: 'http://example.test' },
      { certificateExpiryDays: 366 },
      { certificateExpiryDays: null },
      { method: 'ICMP_PING', target: 'localhost:80' },
      { checkProxy: 'globalping' },
      { checkProxy: 'https://user:password@example.test' },
      { checkProxyHeaders: { Authorization: 'bad\r\nheader' } },
    ]) {
      expect(
        (await handleProbeRequest(request(), env, [{ ...targets[0], ...invalid } as MonitorTarget]))
          .status
      ).toBe(503)
    }
  })
  it('validates and persists typed metadata, and conflicting replays cannot alter or add details', async () => {
    const batch = (result: unknown) => ({ version: 1, batch_id: '0'.repeat(64), results: [result] })
    async function ingest(result: unknown) {
      return handleProbeRequest(
        new Request('https://test/api/probes/ingest', {
          method: 'POST',
          headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(batch(result)),
        }),
        env,
        monitors
      )
    }
    const result = {
      ...row(NOW),
      certificate_expires_at: NOW + 86400,
      certificate_days_remaining: 1.5,
      icmp_latency_ms: 4.5,
    }
    expect((await ingest(result)).status).toBe(200)
    expect((await ingest({ ...result, certificate_expires_at: NOW + 100000 })).status).toBe(200)
    let summary = (await getProbeSummaries(env, monitors, [], NOW)).web.probes[0]
    expect(summary).toMatchObject({
      certificateExpiresAt: NOW + 86400,
      certificateDaysRemaining: 1.5,
      icmpLatencyMs: 4.5,
    })
    expect((await ingest(row(NOW + 1))).status).toBe(200)
    expect((await ingest({ ...row(NOW + 1), certificate_expires_at: NOW + 100000 })).status).toBe(
      200
    )
    summary = (await getProbeSummaries(env, monitors, [], NOW + 1)).web.probes[0]
    expect(summary.certificateExpiresAt).toBeUndefined()
    for (const invalid of [
      { certificate_expires_at: -1 },
      { certificate_expires_at: 1.5 },
      { certificate_expires_at: '123' },
      { certificate_days_remaining: '1' },
      { icmp_latency_ms: -1 },
      { icmp_latency_ms: 300001 },
    ])
      expect((await ingest({ ...row(NOW + 2), ...invalid })).status).toBe(400)
    expect((await ingest({ ...row(NOW + 3, false), stage: 'icmp', code: 'timeout' })).status).toBe(
      200
    )
    expect((await ingest({ ...row(NOW + 4, false), stage: 'proxy', code: 'status' })).status).toBe(
      200
    )
  })
})

describe('native episode history', () => {
  it('keeps native duration/reason changes, clips ongoing episodes at the window and ignores dummy records', async () => {
    const state = new CompactedMonitorStateWrapper(null)
    state.appendIncident('native', { start: [NOW - 1000], end: NOW - 1000, error: ['dummy'] })
    state.appendIncident('native', {
      start: [NOW - 900, NOW - 600],
      end: NOW - 300,
      error: ['[tcp/refused] Refused', '[dns/not_found] No answer'],
    })
    state.appendIncident('native', {
      start: [NOW - 200],
      end: null,
      error: ['[tls/certificate] Certificate invalid'],
    })
    await setToStore(env as any, 'state', state.getCompactedStateStr())
    const page = await getNativeIncidents(
      env,
      monitors,
      { from: NOW - 700, to: NOW + 1, limit: 1 },
      NOW
    )
    expect(page.incidents[0]).toMatchObject({
      monitorName: 'Native service',
      start: NOW - 200,
      end: null,
      stale: true,
    })
    const older = await getNativeIncidents(
      env,
      monitors,
      { from: NOW - 700, to: NOW + 1, limit: 1, cursor: page.nextCursor! },
      NOW
    )
    expect(older.incidents[0]).toMatchObject({ start: NOW - 700, end: NOW - 300, continued: true })
    expect(older.incidents[0].reasons.map((reason) => reason.stage)).toEqual(['tcp', 'dns'])
    expect(older.nextCursor).toBeNull()
  })
})
