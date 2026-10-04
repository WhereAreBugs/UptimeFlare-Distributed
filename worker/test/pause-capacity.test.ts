import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { Miniflare } from 'miniflare'
import { readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import type { MonitorTarget, WorkerConfig } from '../../types/config'
import { handleAdminRequest, validateSettings, type AdminEnv } from '../src/admin'
import { getRuntimeConfig } from '../src/settings'
import { getProbeSummaries, handleProbeRequest, persistBatch } from '../src/probes'
import { runCloudflareProbe } from '../src/cloudflare-probe'
import { runNativeMonitors } from '../src/native-monitor'
import { claimScheduledMonitors, completeScheduledClaim, cleanupMonitorSchedules } from '../src/scheduling'
import { queueNotification, runNotifications, deliverNotifications } from '../src/notifications'
import { pauseTransitionStatements } from '../src/pause'
import { CompactedMonitorStateWrapper, getFromStore } from '../src/store'
import type { Env } from '../src/index'

const NOW = Math.floor(Date.now() / 60000) * 60
const TOKEN = 'pause-fixture-probe-token-at-least-24'
const PASSWORD = 'pause-fixture-password-at-least-16'
const monitor: MonitorTarget = {
  id: 'web', name: 'Web', method: 'GET', target: 'https://example.test', probes: ['a', 'b'],
  notificationTemplateId: 'notice',
}
const config: WorkerConfig = {
  probes: [{ id: 'a' }, { id: 'b' }], monitors: [monitor],
  notificationTemplates: [{ id: 'notice', name: 'Notice', type: 'webhook', webhook: {
    url: 'https://hook.test', payloadType: 'json', payload: { status: '$STATUS' },
  } }],
  maintenances: [],
}
let mf: Miniflare
let env: AdminEnv
let cookie: string
beforeAll(async () => {
  const Bytes = Uint8Array as any
  Bytes.fromHex ??= (value: string) => Uint8Array.from(Buffer.from(value, 'hex'))
  Bytes.prototype.toHex ??= function () { return Buffer.from(this).toString('hex') }
  mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: '2025-04-02', d1Databases: ['UPTIMEFLARE_D1'] })
  env = { UPTIMEFLARE_D1: await mf.getD1Database('UPTIMEFLARE_D1') as unknown as D1Database,
    PROBE_TOKENS: JSON.stringify({ a: TOKEN, b: TOKEN + '-b' }),
    ADMIN_PASSWORD: PASSWORD, ADMIN_SESSION_SECRET: 'pause-fixture-session-secret-at-least-32' }
  for (const sql of readFileSync(new URL('../../init.sql', import.meta.url), 'utf8').split(';').filter(sql => sql.trim()))
    await env.UPTIMEFLARE_D1.prepare(sql).run()
}, 30000)
beforeEach(async () => {
  for (const table of ['admin_config', 'admin_login_attempts', 'notification_outbox', 'notification_state',
    'notification_observations', 'monitor_schedule', 'uptimeflare', 'probe_latest', 'probe_samples',
    'probe_days', 'probe_sample_details', 'probe_buckets', 'probe_totals', 'probe_bucket_stages', 'probe_stage_totals'])
    await env.UPTIMEFLARE_D1.prepare(`DELETE FROM ${table}`).run()
  const clock = vi.spyOn(Date, 'now').mockReturnValue(NOW * 1000)
  const login = await handleAdminRequest(new Request('https://test/api/admin/login', {
    method: 'POST', headers: { Origin: 'https://test', 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: PASSWORD }),
  }), env, config)
  clock.mockRestore()
  cookie = login.headers.get('Set-Cookie')!.split(';')[0]
})
afterEach(() => vi.restoreAllMocks())
afterAll(async () => { await mf?.dispose() })
async function save(paused: boolean, revision: number, at = NOW + 10) {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(at * 1000)
  try {
    return await handleAdminRequest(new Request('https://test/api/admin/config', {
      method: 'PUT', headers: { Origin: 'https://test', 'Content-Type': 'application/json', Cookie: cookie },
      body: JSON.stringify({ ...config, revision, monitors: [{ ...monitor, paused }] }),
    }), env, config)
  } finally { clock.mockRestore() }
}
async function remote(targets: MonitorTarget[]) {
  return handleProbeRequest(new Request('https://test/api/probes/config', {
    headers: { Authorization: 'Bearer ' + TOKEN },
  }), env, targets)
}
async function ingest(targets: MonitorTarget[], samples: unknown[]) {
  return handleProbeRequest(new Request('https://test/api/probes/ingest', {
    method: 'POST', headers: { Authorization: 'Bearer ' + TOKEN,
      'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
    body: gzipSync(JSON.stringify({ version: 1, batch_id: 'a'.repeat(64), results: samples })),
  }), env, targets)
}
const sample = (time = NOW, id = 'web', up = false) => ({ monitor_id: id, time, up, latency_ms: 1,
  ...(up ? {} : { stage: 'tcp' as const, code: 'refused' }) })
async function count(table: string) {
  return (await env.UPTIMEFLARE_D1.prepare(`SELECT COUNT(*) n FROM ${table}`).first<{ n: number }>())!.n
}
const success = (target: MonitorTarget) => Promise.resolve({ id: target.id, location: 'SIN', status: { up: true, ping: 1, err: '' } })

it('validates paused strictly, preserves explicit false, and supports300 assignments within bounded limits', () => {
  for (const paused of [true, false]) expect(validateSettings({ ...config, monitors: [{ ...monitor, paused }] }, new Set(['a', 'b'])).monitors[0].paused).toBe(paused)
  expect(validateSettings(config, new Set(['a', 'b'])).monitors[0].paused).toBeUndefined()
  for (const paused of [0, 1, null, 'false']) expect(() => validateSettings({ ...config, monitors: [{ ...monitor, paused }] }, new Set(['a', 'b']))).toThrow('暂停')
  const targets = Array.from({ length: 100 }, (_, index) => ({ ...monitor, id: `web-${index}`, probes: ['a', 'b', 'cloudflare'] }))
  expect(validateSettings({ ...config, monitors: targets }, new Set(['a', 'b'])).monitors).toHaveLength(100)
  expect(() => validateSettings({ ...config, monitors: [...targets, targets[0]] }, new Set(['a', 'b']))).toThrow('100')
  expect(() => validateSettings({ ...config, probes: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
    monitors: targets.map(target => ({ ...target, probes: ['a', 'b', 'c', 'cloudflare'] })) }, new Set(['a', 'b', 'c']))).toThrow('330')
})

it('omits paused assignments but accepts gzip backlog/replay, preserving history and ownership checks', async () => {
  const paused = [{ ...monitor, paused: true }, { ...monitor, id: 'other', probes: ['b'] }]
  expect(await (await remote(paused)).json()).toMatchObject({ monitors: [] })
  expect((await ingest(paused, [sample(NOW - 120)])).status).toBe(200)
  expect((await ingest(paused, [sample(NOW - 120)])).status).toBe(200)
  expect(await count('probe_samples')).toBe(1)
  expect((await ingest(paused, [sample(NOW - 100), sample(NOW - 100, 'other')])).status).toBe(403)
  expect(await count('probe_samples')).toBe(1)
  const summary = (await getProbeSummaries(env, paused, config.probes, NOW)).web
  expect(summary).toMatchObject({ paused: true, status: 'paused' })
  expect(summary.probes[0]).toMatchObject({ checks: 1, failures: 1 })
  expect(summary.dailyHistory.some(day => day.checks === 1)).toBe(true)
  expect((await (await remote([{ ...monitor, paused: false }])).json() as any).monitors).toHaveLength(1)
})

it('saves pause, cancels queued notifications/leases atomically, and makes conflicting writes inert', async () => {
  await queueNotification(env, monitor, 'down', NOW, 'refused', NOW + 1)
  expect(await count('notification_outbox')).toBe(1)
  await claimScheduledMonitors(env, 'cloudflare', [{ ...monitor, probes: ['cloudflare'] }], NOW, NOW)
  const response = await save(true, 0)
  expect(response.status).toBe(200)
  expect(await response.json()).toMatchObject({ revision: 1, monitors: [{ paused: true }] })
  expect(await count('notification_outbox')).toBe(0)
  expect(await count('notification_state')).toBe(0)
  expect(await count('monitor_schedule')).toBe(0)
  const marker = () => env.UPTIMEFLARE_D1.prepare('SELECT status,sample_time,version FROM notification_observations WHERE monitor_id=?').bind('web').first()
  const pausedMarker = await marker()
  expect(pausedMarker).toMatchObject({ status: 'paused', sample_time: NOW + 10 })
  expect((await save(false, 0, NOW + 20)).status).toBe(409)
  expect(await marker()).toEqual(pausedMarker)
  expect((await remote((await getRuntimeConfig(env, config)).monitors)).status).toBe(200)
  expect(await (await remote((await getRuntimeConfig(env, config)).monitors)).json()).toMatchObject({ monitors: [] })
  const restored = await save(false, 1, NOW + 30)
  expect(restored.status).toBe(200)
  expect(await restored.text()).not.toContain('_writeId')
  expect(await marker()).toMatchObject({ status: 'awaiting', sample_time: NOW + 30 })
  expect((await (await remote((await getRuntimeConfig(env, config)).monitors)).json() as any).monitors).toHaveLength(1)
})

it('requires post-resume data from every assigned probe and restarts grace instead of alerting from offline failures', async () => {
  const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))
  await persistBatch(env, 'a', [sample(NOW)]); await persistBatch(env, 'b', [sample(NOW)])
  await queueNotification(env, monitor, 'down', NOW, 'old failure', NOW + 1)
  expect((await save(true, 0, NOW + 10)).status).toBe(200)
  await persistBatch(env, 'a', [sample(NOW + 50)]); await persistBatch(env, 'b', [sample(NOW + 50)])
  await runNotifications(env, await getRuntimeConfig(env, config), NOW + 60, send)
  expect(send).not.toHaveBeenCalled()
  expect((await save(false, 1, NOW + 100)).status).toBe(200)
  const resumed = await getRuntimeConfig(env, config)
  resumed.monitors[0].notificationGracePeriodSeconds = 60
  await runNotifications(env, resumed, NOW + 101, send)
  await persistBatch(env, 'a', [sample(NOW + 101)])
  await runNotifications(env, resumed, NOW + 102, send)
  expect(send).not.toHaveBeenCalled()
  await persistBatch(env, 'b', [sample(NOW + 102)])
  await runNotifications(env, resumed, NOW + 103, send)
  await runNotifications(env, resumed, NOW + 170, send)
  expect(send).not.toHaveBeenCalled()
  await persistBatch(env, 'a', [sample(NOW + 170)]); await persistBatch(env, 'b', [sample(NOW + 170)])
  await runNotifications(env, resumed, NOW + 171, send)
  expect(send).toHaveBeenCalledOnce()
  expect(JSON.parse(send.mock.calls[0][1]!.body as string)).toMatchObject({ status: 'down' })
})

it('fences a stale notification evaluator and delivery snapshot after an admin pause', async () => {
  expect((await save(true, 0)).status).toBe(200)
  await queueNotification(env, monitor, 'down', NOW + 30, 'stale config', NOW + 31)
  expect(await count('notification_outbox')).toBe(0)
  await env.UPTIMEFLARE_D1.prepare("INSERT INTO notification_outbox(event_id,monitor_id,template_id,sequence,value,created_at,next_attempt_at) VALUES('stale','web','notice',1,'{}',?,?)").bind(NOW, NOW).run()
  const send = vi.fn<typeof fetch>()
  await deliverNotifications(env, config, NOW + 40, send)
  expect(send).not.toHaveBeenCalled()
  const marker = () => env.UPTIMEFLARE_D1.prepare("SELECT status,sample_time FROM notification_observations WHERE monitor_id='web'").first()
  // An older active Cron snapshot must not reinterpret the saved pause as a resume.
  await runNotifications(env, config, NOW + 41, send)
  expect(await marker()).toEqual({ status: 'paused', sample_time: NOW + 10 })
  expect((await save(false, 1, NOW + 50)).status).toBe(200)
  await runNotifications(env, { ...config, monitors: [{ ...monitor, paused: true }] }, NOW + 60, send)
  expect(await marker()).toEqual({ status: 'awaiting', sample_time: NOW + 50 })
})

it('stops native/Cloudflare checks, keeps their stored history, resumes due work, and fences late completion', async () => {
  const targets = [{ ...monitor, probes: ['cloudflare'] }]
  const check = vi.fn(success)
  await runCloudflareProbe(env as Env, targets, NOW, 'SIN', check)
  await cleanupMonitorSchedules(env, [{ ...targets[0], paused: true }])
  await runCloudflareProbe(env as Env, [{ ...targets[0], paused: true }], NOW + 60, 'SIN', check)
  expect(check).toHaveBeenCalledOnce()
  await runCloudflareProbe(env as Env, targets, NOW + 120, 'SIN', check)
  expect(check).toHaveBeenCalledTimes(2)
  const native = { ...monitor, probes: undefined, notificationTemplateId: undefined }
  const nativeCheck = vi.fn(success)
  await runNativeMonitors(env as Env, { monitors: [native] }, NOW, 'SIN', nativeCheck)
  const original = await getFromStore(env, 'state')
  await runNativeMonitors(env as Env, { monitors: [{ ...native, paused: true }] }, NOW + 60, 'SIN', nativeCheck)
  expect(nativeCheck).toHaveBeenCalledOnce()
  expect(await getFromStore(env, 'state')).toBe(original)
  expect(new CompactedMonitorStateWrapper(original).getLastLatency('web').time).toBe(NOW)
  // A check that was claimed before pause cannot append a late result after its lease is revoked.
  const late = { ...monitor, id: 'late', probes: ['cloudflare'] }
  const lateCheck = vi.fn(async (target: MonitorTarget) => {
    await env.UPTIMEFLARE_D1.batch(pauseTransitionStatements(env, [{ id: 'late', paused: true }], NOW + 61))
    return success(target)
  })
  await runCloudflareProbe(env as Env, [late], NOW + 60, 'SIN', lateCheck)
  expect(await env.UPTIMEFLARE_D1.prepare("SELECT COUNT(*) n FROM probe_samples WHERE monitor_id='late'").first()).toEqual({ n: 0 })
  const lateNative = { ...native, id: 'native-late' }
  const nativeLateCheck = vi.fn(async (target: MonitorTarget) => {
    await env.UPTIMEFLARE_D1.batch(pauseTransitionStatements(env, [{ id: target.id, paused: true, native: true }], NOW + 181))
    return success(target)
  })
  await runNativeMonitors(env as Env, { monitors: [lateNative] }, NOW + 180, 'SIN', nativeLateCheck)
  expect(await getFromStore(env, 'state')).toBe(original)
})

it('reads100 three-probe summaries with exactly six bulk SQL statements', async () => {
  const targets = Array.from({ length: 100 }, (_, index) => ({ ...monitor, id: `web-${index}`, probes: ['a', 'b', 'cloudflare'] }))
  for (const probe of ['a', 'b', 'cloudflare']) await persistBatch(env, probe, targets.map(target => sample(NOW, target.id, true)))
  const batch = vi.fn(env.UPTIMEFLARE_D1.batch.bind(env.UPTIMEFLARE_D1))
  const scoped = { ...env, UPTIMEFLARE_D1: { prepare: env.UPTIMEFLARE_D1.prepare.bind(env.UPTIMEFLARE_D1), batch } as unknown as D1Database }
  const summaries = await getProbeSummaries(scoped, targets, config.probes, NOW)
  expect(Object.keys(summaries)).toHaveLength(100)
  expect(Object.values(summaries).every(summary => summary.probes.length === 3 && summary.status === 'up')).toBe(true)
  expect(batch).toHaveBeenCalledOnce()
  expect(batch.mock.calls[0][0]).toHaveLength(6)
  expect((await (await remote(targets)).json() as any).monitors).toHaveLength(100)
})

it('spreads75 new Cloudflare targets across three fair Cron batches, never exceeding five concurrent checks', async () => {
  const targets = Array.from({ length: 75 }, (_, index) => ({ ...monitor, id: `web-${index.toString().padStart(2, '0')}`, probes: ['cloudflare'] }))
  let running = 0, maximum = 0
  const check = vi.fn(async (target: MonitorTarget) => {
    maximum = Math.max(maximum, ++running)
    await Promise.resolve()
    running--
    return success(target)
  })
  for (let round = 0; round < 3; round++) {
    await runCloudflareProbe(env as Env, targets, NOW + round * 60, 'SIN', check)
    expect(check).toHaveBeenCalledTimes((round + 1) * 25)
  }
  expect(new Set(check.mock.calls.map(([target]) => target.id)).size).toBe(75)
  expect(maximum).toBeLessThanOrEqual(5)
  await runCloudflareProbe(env as Env, targets, NOW + 180, 'SIN', check)
  expect(check).toHaveBeenCalledTimes(75)
  await runCloudflareProbe(env as Env, targets, NOW + 300, 'SIN', check)
  expect(check).toHaveBeenCalledTimes(100)
  expect(check.mock.calls.slice(75).map(([target]) => target.id)).toEqual(check.mock.calls.slice(0, 25).map(([target]) => target.id))
})

it('bounds long-timeout claims by the remaining scheduled lifetime and rejects paused stale snapshots', async () => {
  const targets = Array.from({ length: 100 }, (_, index) => ({ ...monitor, id: `web-${index}`, timeout: 120000, probes: ['cloudflare'] }))
  const claim = await claimScheduledMonitors(env, 'cloudflare', targets, NOW, NOW + 600)
  expect(claim.monitors).toHaveLength(10)
  await completeScheduledClaim(env, claim).run()
  expect((await claimScheduledMonitors(env, 'cloudflare', targets, NOW + 60, NOW + 850)).monitors).toHaveLength(0)
  expect((await save(true, 0)).status).toBe(200)
  expect((await claimScheduledMonitors(env, 'cloudflare', [{ ...monitor, probes: ['cloudflare'] }], NOW + 120, NOW + 120)).monitors).toHaveLength(0)
})

it('does not let an old paused snapshot delete a resumed claim or a newly queued notification', async () => {
  expect((await save(true, 0, NOW + 10)).status).toBe(200)
  expect((await save(false, 1, NOW + 50)).status).toBe(200)
  const claim = await claimScheduledMonitors(env, 'cloudflare', [{ ...monitor, probes: ['cloudflare'] }], NOW + 60, NOW + 60)
  await cleanupMonitorSchedules(env, [{ ...monitor, paused: true }])
  expect(await env.UPTIMEFLARE_D1.prepare("SELECT lease_key FROM monitor_schedule WHERE scope='cloudflare' AND monitor_id='web'").first()).toEqual({ lease_key: claim.key })
  await queueNotification(env, monitor, 'down', NOW + 60, 'fresh failure', NOW + 61)
  expect(await count('notification_outbox')).toBe(1)
  const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))
  await deliverNotifications(env, { ...config, monitors: [{ ...monitor, paused: true }] }, NOW + 62, send)
  expect(send).toHaveBeenCalledOnce()
  expect(await count('notification_outbox')).toBe(0)
})

it('does not revoke a healthy native writer on later Cron ticks just because another native target stays paused', async () => {
  const paused = { ...monitor, id: 'paused-native', probes: undefined, notificationTemplateId: undefined, paused: true }
  const active = { ...monitor, id: 'active-native', probes: undefined, notificationTemplateId: undefined }
  const mixed: WorkerConfig = { monitors: [paused, active], maintenances: [] }
  await runNotifications(env, mixed, NOW)
  let started!: () => void, finish!: () => void
  const start = new Promise<void>(resolve => { started = resolve })
  const completion = new Promise<void>(resolve => { finish = resolve })
  const check = vi.fn(async (target: MonitorTarget) => {
    started()
    await completion
    return success(target)
  })
  const first = runNativeMonitors(env as Env, mixed, NOW, 'SIN', check)
  await start
  const writer = await env.UPTIMEFLARE_D1.prepare("SELECT lease_key FROM monitor_schedule WHERE scope='native-writer'").first()
  await runNativeMonitors(env as Env, mixed, NOW + 60, 'SIN', check)
  await runNotifications(env, mixed, NOW + 60)
  expect(await env.UPTIMEFLARE_D1.prepare("SELECT lease_key FROM monitor_schedule WHERE scope='native-writer'").first()).toEqual(writer)
  finish()
  await first
  expect(check).toHaveBeenCalledOnce()
  expect(new CompactedMonitorStateWrapper(await getFromStore(env, 'state')).getLastLatency(active.id).time).toBe(NOW)
})

it('shares25 checks across busy native and Cloudflare scopes while reserving each scope a fair share', async () => {
  const cloudflare = Array.from({ length: 50 }, (_, index) => ({ ...monitor, id: `cf-${index}`, intervalSeconds: 60, probes: ['cloudflare'] }))
  const native = Array.from({ length: 50 }, (_, index) => ({ ...monitor, id: `native-${index}`, intervalSeconds: 60, probes: undefined }))
  const check = vi.fn(success)
  const targets = [...cloudflare, ...native]
  for (let round = 0; round < 2; round++) {
    const budget = { remaining: 25 }
    await runCloudflareProbe(env as Env, targets, NOW + round * 60, 'SIN', check, budget, 12)
    expect(budget.remaining).toBe(13)
    await runNativeMonitors(env as Env, { monitors: targets }, NOW + round * 60, 'SIN', check, budget)
    expect(budget.remaining).toBe(0)
  }
  expect(check.mock.calls.filter(([target]) => target.id.startsWith('cf-'))).toHaveLength(24)
  expect(check.mock.calls.filter(([target]) => target.id.startsWith('native-'))).toHaveLength(26)
  expect(new Set(check.mock.calls.map(([target]) => target.id)).size).toBe(50)
})

it.each([
  { name: 'evaluator', evaluate: runNotifications },
  { name: 'delivery', evaluate: deliverNotifications },
])('fences $name cleanup when admin resume and a new job arrive after its pause projection read', async ({ evaluate }) => {
  expect((await save(true, 0, NOW + 10)).status).toBe(200)
  let interleaved = false
  const database = env.UPTIMEFLARE_D1
  const wrapped: AdminEnv = { ...env, UPTIMEFLARE_D1: {
    batch: database.batch.bind(database),
    prepare(sql: string) {
      const statement = database.prepare(sql)
      if (!sql.includes('SELECT config.revision,') || interleaved) return statement
      return { bind(...values: unknown[]) {
        const bound = statement.bind(...values)
        return { async first() {
          const prior = await bound.first()
          interleaved = true
          // Commit the resume/new target only after the old paused snapshot has been read.
          const clock = vi.spyOn(Date, 'now').mockReturnValue((NOW + 50) * 1000)
          const write = await handleAdminRequest(new Request('https://test/api/admin/config', {
            method: 'PUT', headers: { Origin: 'https://test', 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ ...config, revision: 1, monitors: [{ ...monitor, paused: false },
              { ...monitor, id: 'new-target', paused: true }] }),
          }), env, config)
          clock.mockRestore()
          expect(write.status).toBe(200)
          await queueNotification(env, monitor, 'down', NOW + 60, 'fresh resumed failure', NOW + 61)
          return prior
        } }
      } } as D1PreparedStatement
    },
  } as unknown as D1Database }
  const send = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))
  await evaluate(wrapped, config, NOW + 62, send)
  expect(interleaved).toBe(true)
  expect(send).not.toHaveBeenCalled()
  expect(await count('notification_outbox')).toBe(1)
  expect(await env.UPTIMEFLARE_D1.prepare("SELECT status FROM notification_state WHERE monitor_id='web'").first()).toEqual({ status: 'down' })
  expect(await env.UPTIMEFLARE_D1.prepare("SELECT status FROM notification_observations WHERE monitor_id='new-target'").first()).toEqual({ status: 'paused' })
  await deliverNotifications(env, await getRuntimeConfig(env, config), NOW + 63, send)
  expect(send).toHaveBeenCalledOnce()
  expect(await count('notification_outbox')).toBe(0)
})
