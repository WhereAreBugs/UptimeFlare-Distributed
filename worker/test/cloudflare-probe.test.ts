import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import { readFileSync } from 'node:fs'
import { runCloudflareProbe } from '../src/cloudflare-probe'
import { getProbeSummaries, handleProbeRequest, persistBatch } from '../src/probes'
import { getSettings } from '../src/settings'
import { recordProbeNetwork } from '../src/probe-labels'
import { validateSettings } from '../src/admin'
import type { Env } from '../src/index'
import type { WorkerConfig } from '../../types/config'

let mf: Miniflare
let env: Env
const NOW = Math.floor(Date.now() / 60000) * 60
const TOKEN = 'external-test-probe-secret-123456789'
const config: WorkerConfig = {
  probes: [{ id: 'a' }],
  monitors: [
    {
      id: 'mixed',
      name: 'Mixed',
      method: 'GET',
      target: 'https://test.example',
      probes: ['a', 'cloudflare'],
    },
    {
      id: 'cf-only',
      name: 'CF only',
      method: 'GET',
      target: 'https://test.example',
      probes: ['cloudflare'],
    },
    {
      id: 'external',
      name: 'External only',
      method: 'GET',
      target: 'https://test.example',
      probes: ['a'],
    },
    { id: 'legacy', name: 'Legacy', method: 'GET', target: 'https://test.example' },
  ],
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
    PROBE_TOKENS: JSON.stringify({ a: TOKEN }),
  } as Env
  for (const statement of readFileSync(new URL('../../init.sql', import.meta.url), 'utf8')
    .split(';')
    .filter((s) => s.trim()))
    await env.UPTIMEFLARE_D1.prepare(statement).run()
}, 30000)
afterAll(async () => {
  await mf?.dispose()
})

describe('Cloudflare and external probes share retained D1 results', () => {
  it('assigns Cloudflare without a token and strips derived labels from saved overrides', () => {
    const validated = validateSettings(
      {
        ...config,
        monitors: config.monitors.filter((m) => m.probes),
        probeStaleAfterSeconds: 900,
        probes: [{ id: 'a', defaultName: 'spoofed' }, { id: 'cloudflare' }],
      },
      new Set(['a'])
    )
    expect(validated.probes).toEqual([{ id: 'a' }, { id: 'cloudflare' }])
    expect(validated.monitors[1].probes).toEqual(['cloudflare'])
  })
  it('runs only assigned targets, retains failure phases and deduplicates repeated cron minute', async () => {
    const seen: string[] = []
    const check = async (monitor: any) => {
      seen.push(monitor.id)
      expect(monitor.checkProxy).toBeUndefined()
      return {
        id: monitor.id,
        location: 'SIN',
        status: {
          up: monitor.id === 'cf-only',
          ping: 7,
          err: monitor.id === 'cf-only' ? '' : '[http/status] Expected codes: 2xx, Got: 503',
        },
      }
    }
    await runCloudflareProbe(env, config.monitors, NOW, 'SIN', check)
    await runCloudflareProbe(env, config.monitors, NOW, 'SIN', check)
    expect(seen).toEqual(['mixed', 'cf-only'])
    expect(
      (await env.UPTIMEFLARE_D1.prepare('SELECT COUNT(*) n FROM probe_samples').first<any>()).n
    ).toBe(2)
    await persistBatch(env, 'a', [{ monitor_id: 'mixed', time: NOW, up: true, latency_ms: 12 }])
    const settings = await getSettings(env, config)
    const summaries = await getProbeSummaries(env, config.monitors, settings.probes, NOW)
    expect(summaries.mixed.status).toBe('degraded')
    expect(summaries['cf-only'].status).toBe('up')
    expect(summaries.mixed.probes[1]).toMatchObject({
      id: 'cloudflare',
      name: 'Cloudflare SIN · AS13335',
      stage: 'http',
      code: 'status',
      checks: 1,
      failures: 1,
      failureStages: { http: 1 },
    })
    await runCloudflareProbe(env, [config.monitors[2]], NOW + 60, 'SIN', check)
    expect(seen).toHaveLength(2)
  })
  it('keeps Cloudflare history monotonic when a late cron event finishes', async () => {
    const check = async (monitor: any) => ({
      id: monitor.id,
      location: 'SIN',
      status: { up: true, ping: 3, err: '' },
    })
    await runCloudflareProbe(env, [config.monitors[0]], NOW - 60, 'SIN', check)
    expect(
      await env.UPTIMEFLARE_D1.prepare(
        "SELECT time, up FROM probe_latest WHERE probe_id='cloudflare' AND monitor_id='mixed'"
      ).first()
    ).toMatchObject({ time: NOW, up: 0 })
  })
  it('cannot impersonate the built-in identity with a bearer credential', async () => {
    const response = await handleProbeRequest(
      new Request('https://test.example/api/probes/config', {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
      { ...env, PROBE_TOKENS: JSON.stringify({ cloudflare: TOKEN }) },
      config.monitors
    )
    expect(response.status).toBe(503)
  })
})

describe('default labels from trusted source-IP geography and ASN', () => {
  it('records only after successful authentication and accepts no forged client headers', async () => {
    const cf = { country: 'US', region: 'California', city: 'Los Angeles', asn: 64512 }
    const request = new Request('https://test.example/api/probes/config', {
      headers: { Authorization: `Bearer wrong`, 'X-Probe-ASN': '1' },
    })
    expect((await handleProbeRequest(request, env, config.monitors, cf)).status).toBe(401)
    expect(
      await env.UPTIMEFLARE_D1.prepare("SELECT * FROM probe_metadata WHERE probe_id='a'").first()
    ).toBeNull()
    const valid = new Request(request.url, { headers: { Authorization: `Bearer ${TOKEN}` } })
    expect((await handleProbeRequest(valid, env, config.monitors, cf)).status).toBe(200)
    const row = await env.UPTIMEFLARE_D1.prepare(
      "SELECT * FROM probe_metadata WHERE probe_id='a'"
    ).first()
    expect(row).toMatchObject({ default_name: 'US / California / Los Angeles · AS64512' })
    await recordProbeNetwork(env, 'a', { country: 'bad\nlabel', asn: 0 })
    await recordProbeNetwork(env, 'a', undefined)
    expect(
      await env.UPTIMEFLARE_D1.prepare("SELECT * FROM probe_metadata WHERE probe_id='a'").first()
    ).toEqual(row)
  })
  it('does not rewrite unchanged metadata, refreshes changed ASN and preserves custom names', async () => {
    const unchanged = await recordProbeNetwork(env, 'a', {
      country: 'US',
      region: 'California',
      city: 'Los Angeles',
      asn: 64512,
    })
    expect(unchanged!.meta.changes).toBe(0)
    await recordProbeNetwork(env, 'a', { country: 'SG', city: 'Singapore', asn: 64513 })
    const settings = await getSettings(env, {
      ...config,
      probes: [{ id: 'a', name: 'Custom', location: 'Manual' }],
    })
    const summaries = await getProbeSummaries(env, config.monitors, settings.probes, NOW)
    expect(summaries.mixed.probes[0]).toMatchObject({ name: 'Custom', location: 'Manual' })
    expect(settings.probes![0]).toMatchObject({
      name: 'Custom',
      defaultName: 'SG / Singapore · AS64513',
    })
  })
})
