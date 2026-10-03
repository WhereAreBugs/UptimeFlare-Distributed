import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Miniflare } from 'miniflare'
import { readFileSync } from 'node:fs'
import { runCloudflareProbe } from '../src/cloudflare-probe'
import { runNativeMonitors } from '../src/native-monitor'
import { persistBatch, getProbeSummaries, handleProbeRequest } from '../src/probes'
import { validateSettings } from '../src/admin'
import { getSettings, getRuntimeConfig } from '../src/settings'
import { CompactedMonitorStateWrapper, getFromStore, setToStore } from '../src/store'
import { runNotifications } from '../src/notifications'
import { cleanupMonitorSchedules } from '../src/scheduling'
import type { Env } from '../src/index'
import type { MonitorTarget, WorkerConfig } from '../../types/config'

const NOW = Math.floor(Date.now() / 60000) * 60
const TOKEN = 'test-per-target-interval-probe-secret-123456'
let mf: Miniflare
let env: Env
const monitor = (id: string, intervalSeconds?: number, probes = ['cloudflare']): MonitorTarget => ({
  id,
  name: id,
  method: 'GET',
  target: 'https://target.example',
  ...(intervalSeconds !== undefined && { intervalSeconds }),
  probes,
})
const success = () =>
  vi.fn(async (monitor: MonitorTarget) => ({
    id: monitor.id,
    location: 'SIN',
    status: { up: true, ping: 2, err: '' },
  }))

beforeAll(async () => {
  // The upstream compacted-state implementation uses Workers' native hex APIs.
  // Node24.3 lacks them; emulate those APIs here without changing its stored format.
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
    PROBE_TOKENS: JSON.stringify({ p1: TOKEN }),
  } as Env
  for (const sql of readFileSync(new URL('../../init.sql', import.meta.url), 'utf8')
    .split(';')
    .filter((sql) => sql.trim()))
    await env.UPTIMEFLARE_D1.prepare(sql).run()
}, 30000)
beforeEach(async () => {
  for (const table of [
    'monitor_schedule',
    'probe_metadata',
    'admin_config',
    'uptimeflare',
    'notification_state',
    'notification_outbox',
    'probe_samples',
    'probe_latest',
    'probe_buckets',
    'probe_bucket_stages',
    'probe_totals',
    'probe_stage_totals',
  ])
    await env.UPTIMEFLARE_D1.prepare(`DELETE FROM ${table}`).run()
})
afterAll(async () => {
  await mf?.dispose()
})

describe('remote interval and compatibility contract', () => {
  it('returns only assigned targets with interval300/timeout5000 defaults and preserves explicit values', async () => {
    const targets = [
      monitor('default', undefined, ['p1']),
      { ...monitor('explicit', 60, ['p1']), timeout: 10000 },
      monitor('unassigned', 86400, ['other']),
    ]
    const response = await handleProbeRequest(
      new Request('https://test/api/probes/config', {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
      env,
      targets
    )
    expect(response.status).toBe(200)
    const config = (await response.json()) as any
    expect(config.monitors).toMatchObject([
      { id: 'default', intervalSeconds: 300, timeout: 5000 },
      { id: 'explicit', intervalSeconds: 60, timeout: 10000 },
    ])
    expect(config.monitors).toHaveLength(2)
  })
  it('validates optional integer intervals at60..86400 while ignoring obsolete global TTL input', async () => {
    const input = {
      monitors: [monitor('target', undefined, ['p1'])],
      probes: [{ id: 'p1' }],
      probeStaleAfterSeconds: 'obsolete-invalid-value',
    }
    const defaults = validateSettings(input, new Set(['p1']))
    expect(defaults.monitors[0].intervalSeconds).toBe(300)
    expect(defaults).not.toHaveProperty('probeStaleAfterSeconds')
    for (const interval of [60, 86400])
      expect(
        validateSettings(
          { ...input, monitors: [monitor('target', interval, ['p1'])] },
          new Set(['p1'])
        ).monitors[0].intervalSeconds
      ).toBe(interval)
    for (const interval of [0, 59, 86401, 300.5, '300', null]) {
      expect(() =>
        validateSettings(
          { ...input, monitors: [{ ...input.monitors[0], intervalSeconds: interval }] },
          new Set(['p1'])
        )
      ).toThrow('检测周期')
      expect(
        (
          await handleProbeRequest(
            new Request('https://test/api/probes/config', {
              headers: { Authorization: `Bearer ${TOKEN}` },
            }),
            env,
            [{ ...input.monitors[0], intervalSeconds: interval } as any]
          )
        ).status
      ).toBe(503)
    }
  })
  it('ignores saved legacy TTL without rewriting the record, credentials, revision or monitors', async () => {
    const saved = {
      monitors: [{ ...monitor('saved', 60, ['p1']), timeout: 10000 }],
      probes: [{ id: 'p1', name: 'Custom' }],
      notificationTemplates: [],
      probeStaleAfterSeconds: 999999,
      passwordProtection: 'must-not-import-extra-settings',
    }
    const value = JSON.stringify(saved)
    await env.UPTIMEFLARE_D1.prepare(
      'INSERT INTO admin_config(id,revision,value,updated_at) VALUES(1,17,?,0)'
    )
      .bind(value)
      .run()
    const fallback: WorkerConfig = { monitors: [], passwordProtection: 'source-password' }
    const settings = await getSettings(env, fallback)
    const runtime = await getRuntimeConfig(env, { ...fallback, probeStaleAfterSeconds: 1 } as any)
    expect(settings).not.toHaveProperty('probeStaleAfterSeconds')
    expect(runtime).not.toHaveProperty('probeStaleAfterSeconds')
    expect(runtime.passwordProtection).toBe('source-password')
    expect(settings.revision).toBe(17)
    expect(settings.monitors).toEqual(saved.monitors)
    expect(settings.probes![0]).toMatchObject({ id: 'p1', name: 'Custom' })
    expect(env.PROBE_TOKENS).toBe(JSON.stringify({ p1: TOKEN }))
    expect(
      await env.UPTIMEFLARE_D1.prepare('SELECT revision,value FROM admin_config WHERE id=1').first()
    ).toEqual({ revision: 17, value })
  })
  it('derives each target TTL independently and keeps the exact boundary fresh', async () => {
    const targets = [
      monitor('fast', 60, ['p1']),
      monitor('default', undefined, ['p1']),
      monitor('slow', 3600, ['p1']),
    ]
    for (const target of targets)
      await persistBatch(env, 'p1', [{ monitor_id: target.id, time: NOW, up: true, latency_ms: 1 }])
    expect((await getProbeSummaries(env, targets, [], NOW + 120)).fast.status).toBe('up')
    let summaries = await getProbeSummaries(env, targets, [], NOW + 121)
    expect(summaries.fast.status).toBe('unknown')
    expect(summaries.default.status).toBe('up')
    expect(summaries.slow.status).toBe('up')
    expect((await getProbeSummaries(env, targets, [], NOW + 600)).default.status).toBe('up')
    expect((await getProbeSummaries(env, targets, [], NOW + 601)).default.status).toBe('unknown')
    expect((await getProbeSummaries(env, targets, [], NOW + 7200)).slow.status).toBe('up')
    expect((await getProbeSummaries(env, targets, [], NOW + 7201)).slow.status).toBe('unknown')
  })
})

describe('built-in per-target scheduling and durable deduplication', () => {
  it('honors different intervals and defaults, skipping duplicate Cron and unchanged labels when none are due', async () => {
    const targets = [
      monitor('fast', 60),
      monitor('default'),
      { ...monitor('slow', 600), timeout: 10000 },
    ]
    const check = success()
    const location = vi.fn(async () => 'SIN')
    await runCloudflareProbe(env, targets, NOW, location, check)
    expect(check.mock.calls.map(([m]) => [m.id, m.timeout])).toEqual([
      ['fast', 5000],
      ['default', 5000],
      ['slow', 10000],
    ])
    const label = await env.UPTIMEFLARE_D1.prepare(
      "SELECT * FROM probe_metadata WHERE probe_id='cloudflare'"
    ).first()
    await runCloudflareProbe(env, targets, NOW, location, check)
    expect(check).toHaveBeenCalledTimes(3)
    expect(location).toHaveBeenCalledTimes(1)
    expect(
      await env.UPTIMEFLARE_D1.prepare(
        "SELECT * FROM probe_metadata WHERE probe_id='cloudflare'"
      ).first()
    ).toEqual(label)
    await runCloudflareProbe(env, targets, NOW + 60, location, check)
    expect(check.mock.calls.map(([m]) => m.id)).toEqual(['fast', 'default', 'slow', 'fast'])
    await runCloudflareProbe(env, targets, NOW + 300, location, check)
    expect(check.mock.calls.slice(4).map(([m]) => m.id)).toEqual(['fast', 'default'])
    expect(
      (await env.UPTIMEFLARE_D1.prepare('SELECT SUM(checks) n FROM probe_totals').first<any>()).n
    ).toBe(6)
  })
  it('claims concurrent Cron once and takes new/changed targets promptly without rerunning renamed targets', async () => {
    const targets = [monitor('target', 3600)]
    const check = success()
    await Promise.all([
      runCloudflareProbe(env, targets, NOW, 'SIN', check),
      runCloudflareProbe(env, targets, NOW, 'SIN', check),
    ])
    expect(check).toHaveBeenCalledTimes(1)
    await runCloudflareProbe(env, [{ ...targets[0], name: 'renamed' }], NOW + 60, 'SIN', check)
    expect(check).toHaveBeenCalledTimes(1)
    await runCloudflareProbe(
      env,
      [{ ...targets[0], target: 'https://changed.example' }],
      NOW + 120,
      'SIN',
      check
    )
    expect(check).toHaveBeenCalledTimes(2)
    await runCloudflareProbe(
      env,
      [
        { ...targets[0], target: 'https://changed.example', intervalSeconds: 60 },
        monitor('new-target'),
      ],
      NOW + 180,
      'SIN',
      check
    )
    expect(check.mock.calls.slice(2).map(([m]) => m.id)).toEqual(['target', 'new-target'])
    await cleanupMonitorSchedules(env, [targets[0]])
    expect(
      (
        await env.UPTIMEFLARE_D1.prepare(
          "SELECT monitor_id FROM monitor_schedule WHERE scope='cloudflare'"
        ).all()
      ).results
    ).toEqual([{ monitor_id: 'target' }])
  })
  it('fences old result persistence after another invocation reclaims its target lease', async () => {
    let release: (() => void) | undefined
    const blocked = new Promise<void>((resolve) => {
      release = resolve
    })
    const oldCheck = vi.fn(async (m: MonitorTarget) => {
      await blocked
      return {
        id: m.id,
        location: 'SIN',
        status: { up: false, ping: 3, err: '[http/status] Expected codes: 2xx, Got: 503' },
      }
    })
    const targets = [monitor('target')]
    const oldRun = runCloudflareProbe(env, targets, NOW, 'SIN', oldCheck)
    while (!oldCheck.mock.calls.length) await new Promise((resolve) => setTimeout(resolve, 5))
    await env.UPTIMEFLARE_D1.prepare(
      "UPDATE monitor_schedule SET lease_until=0 WHERE scope='cloudflare'"
    ).run()
    await runCloudflareProbe(env, targets, NOW + 60, 'SIN', success())
    release!()
    await oldRun
    expect(
      (await env.UPTIMEFLARE_D1.prepare('SELECT time,up FROM probe_samples').all()).results
    ).toEqual([{ time: NOW + 60, up: 1 }])
    expect(
      await env.UPTIMEFLARE_D1.prepare('SELECT checks,failures FROM probe_totals').first()
    ).toEqual({ checks: 1, failures: 0 })
    expect(
      await env.UPTIMEFLARE_D1.prepare(
        "SELECT last_completed_at,lease_key FROM monitor_schedule WHERE scope='cloudflare'"
      ).first()
    ).toEqual({ last_completed_at: NOW + 60, lease_key: '' })
  })
  it('releases the claim if lazy location resolution rejects before checking', async () => {
    const check = success()
    await expect(
      runCloudflareProbe(
        env,
        [monitor('target')],
        NOW,
        async () => {
          throw new Error('location unavailable')
        },
        check
      )
    ).rejects.toThrow('location unavailable')
    expect(check).not.toHaveBeenCalled()
    expect(
      await env.UPTIMEFLARE_D1.prepare(
        "SELECT last_completed_at,lease_until FROM monitor_schedule WHERE scope='cloudflare'"
      ).first()
    ).toEqual({ last_completed_at: 0, lease_until: 0 })
  })
  it('rolls back sample and schedule completion together on persistence failure, retrying next minute', async () => {
    const check = success()
    await env.UPTIMEFLARE_D1.prepare(
      "CREATE TRIGGER reject_schedule_complete BEFORE UPDATE OF last_completed_at ON monitor_schedule BEGIN SELECT RAISE(ABORT,'test rollback'); END"
    ).run()
    try {
      await expect(
        runCloudflareProbe(env, [monitor('target')], NOW, 'SIN', check)
      ).rejects.toThrow()
    } finally {
      await env.UPTIMEFLARE_D1.prepare('DROP TRIGGER reject_schedule_complete').run()
    }
    expect(
      (await env.UPTIMEFLARE_D1.prepare('SELECT COUNT(*) n FROM probe_samples').first<any>()).n
    ).toBe(0)
    expect(
      await env.UPTIMEFLARE_D1.prepare(
        "SELECT last_completed_at,lease_until FROM monitor_schedule WHERE scope='cloudflare'"
      ).first()
    ).toEqual({ last_completed_at: 0, lease_until: 0 })
    await runCloudflareProbe(env, [monitor('target')], NOW, 'SIN', check)
    expect(check).toHaveBeenCalledTimes(1)
    await runCloudflareProbe(env, [monitor('target')], NOW + 60, 'SIN', check)
    expect(check).toHaveBeenCalledTimes(2)
    expect(
      (await env.UPTIMEFLARE_D1.prepare('SELECT COUNT(*) n FROM probe_samples').first<any>()).n
    ).toBe(1)
  })
})

describe('native target history and notification freshness', () => {
  it('persists only due native targets, preserves each last check and does not write state or resolve location when none are due', async () => {
    const config: WorkerConfig = { monitors: [monitor('fast', 60, []), monitor('slow', 600, [])] }
    const check = success()
    const location = vi.fn(async () => 'SIN')
    await runNativeMonitors(env, config, NOW, location, check)
    const initial = await getFromStore(env, 'state')
    await runNativeMonitors(env, config, NOW, location, check)
    expect(await getFromStore(env, 'state')).toBe(initial)
    expect(check).toHaveBeenCalledTimes(2)
    expect(location).toHaveBeenCalledTimes(1)
    await runNativeMonitors(env, config, NOW + 60, location, check)
    const state = new CompactedMonitorStateWrapper(await getFromStore(env, 'state'))
    expect(state.getLastLatency('fast').time).toBe(NOW + 60)
    expect(state.getLastLatency('slow').time).toBe(NOW)
    expect(check.mock.calls.map(([m]) => m.id)).toEqual(['fast', 'slow', 'fast'])
    const updated = await getFromStore(env, 'state')
    await runNativeMonitors(env, { monitors: [config.monitors[1]] }, NOW + 120, location, check)
    expect(await getFromStore(env, 'state')).toBe(updated)
    expect(location).toHaveBeenCalledTimes(2)
  })
  it('serializes overlapping native writes so one target cannot overwrite another target history', async () => {
    let release: (() => void) | undefined
    const wait = new Promise<void>((resolve) => {
      release = resolve
    })
    const firstCheck = vi.fn(async (m: MonitorTarget) => {
      await wait
      return { id: m.id, location: 'SIN', status: { up: true, ping: 1, err: '' } }
    })
    const first = runNativeMonitors(
      env,
      { monitors: [monitor('a', 60, [])] },
      NOW,
      'SIN',
      firstCheck
    )
    while (!firstCheck.mock.calls.length) await new Promise((resolve) => setTimeout(resolve, 5))
    const secondCheck = success()
    await runNativeMonitors(env, { monitors: [monitor('b', 60, [])] }, NOW + 60, 'SIN', secondCheck)
    expect(secondCheck).not.toHaveBeenCalled()
    release!()
    await first
    await runNativeMonitors(
      env,
      { monitors: [monitor('a', 60, []), monitor('b', 60, [])] },
      NOW + 60,
      'SIN',
      secondCheck
    )
    const state = new CompactedMonitorStateWrapper(await getFromStore(env, 'state'))
    expect(state.getLastLatency('a').time).toBe(NOW + 60)
    expect(state.getLastLatency('b').time).toBe(NOW + 60)
  })
  it('fences native state and completion when its shared writer ownership changes', async () => {
    const check = vi.fn(async (m: MonitorTarget) => {
      await env.UPTIMEFLARE_D1.prepare(
        "UPDATE monitor_schedule SET lease_key='replacement-writer',lease_until=0 WHERE scope='native-writer'"
      ).run()
      return { id: m.id, location: 'SIN', status: { up: true, ping: 1, err: '' } }
    })
    const config = { monitors: [monitor('target', 60, [])] }
    await runNativeMonitors(env, config, NOW, 'SIN', check)
    expect(await getFromStore(env, 'state')).toBeNull()
    expect(
      await env.UPTIMEFLARE_D1.prepare(
        "SELECT last_completed_at,lease_until FROM monitor_schedule WHERE scope='native'"
      ).first()
    ).toEqual({ last_completed_at: 0, lease_until: 0 })
    await runNativeMonitors(env, config, NOW + 60, 'SIN', success())
    expect(
      new CompactedMonitorStateWrapper(await getFromStore(env, 'state')).getLastLatency('target')
        .time
    ).toBe(NOW + 60)
  })
  it('commits native state and schedule atomically before delivering legacy callbacks', async () => {
    const onStatusChange = vi.fn()
    const config: WorkerConfig = {
      monitors: [monitor('target', 60, [])],
      callbacks: { onStatusChange },
    }
    const check = vi.fn(async (m: MonitorTarget) => ({
      id: m.id,
      location: 'SIN',
      status: { up: false, ping: 1, err: '[tcp/refused] Connection refused' },
    }))
    await env.UPTIMEFLARE_D1.prepare(
      "CREATE TRIGGER reject_native_state BEFORE INSERT ON uptimeflare BEGIN SELECT RAISE(ABORT,'test rollback'); END"
    ).run()
    try {
      await expect(runNativeMonitors(env, config, NOW, 'SIN', check)).rejects.toThrow()
    } finally {
      await env.UPTIMEFLARE_D1.prepare('DROP TRIGGER reject_native_state').run()
    }
    expect(await getFromStore(env, 'state')).toBeNull()
    expect(onStatusChange).not.toHaveBeenCalled()
    expect(
      await env.UPTIMEFLARE_D1.prepare(
        "SELECT last_completed_at,lease_until FROM monitor_schedule WHERE scope='native'"
      ).first()
    ).toEqual({ last_completed_at: 0, lease_until: 0 })
    await runNativeMonitors(env, config, NOW + 60, 'SIN', check)
    expect(onStatusChange).toHaveBeenCalledTimes(1)
    expect(
      new CompactedMonitorStateWrapper(await getFromStore(env, 'state')).getLastLatency('target')
        .time
    ).toBe(NOW + 60)
  })
  it('does not alert from a stale native target merely because another target updated global state', async () => {
    const notify = {
      id: 'notice',
      name: 'notice',
      type: 'webhook' as const,
      webhook: {
        url: 'https://hook.test',
        payloadType: 'json' as const,
        payload: { status: '$STATUS' },
      },
    }
    const config: WorkerConfig = {
      notificationTemplates: [notify],
      monitors: [
        { ...monitor('fast', 60, []), notificationTemplateId: 'notice' },
        { ...monitor('slow', 600, []), notificationTemplateId: 'notice' },
      ],
    }
    const state = new CompactedMonitorStateWrapper(null)
    state.data.lastUpdate = NOW
    for (const id of ['fast', 'slow']) {
      state.appendIncident(id, {
        start: [NOW - 121],
        end: null,
        error: ['[tcp/refused] Connection refused'],
      })
      state.appendLatency(id, { time: NOW - 121, ping: 1, loc: 'SIN' })
    }
    await setToStore(env, 'state', state.getCompactedStateStr())
    const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))
    await runNotifications(env, config, NOW, send)
    expect(send).toHaveBeenCalledTimes(1)
    expect(JSON.parse(send.mock.calls[0][1]!.body as string).status).toBe('down')
    expect(
      (await env.UPTIMEFLARE_D1.prepare('SELECT monitor_id FROM notification_state').all()).results
    ).toEqual([{ monitor_id: 'slow' }])
    await runNotifications(env, config, NOW + 1, send)
    expect(send).toHaveBeenCalledTimes(1)
  })
})
