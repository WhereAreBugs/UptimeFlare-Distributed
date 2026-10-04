import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { Miniflare } from 'miniflare'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { WorkerConfig } from '../../types/config'
import type { ProbeEnv } from '../src/probes'
import { persistBatch } from '../src/probes'
import { CompactedMonitorStateWrapper, setToStore } from '../src/store'
import { webhookNotify } from '../src/util'
import {
  deliverNotifications,
  queueNotification,
  runNotifications,
  sendTemplateWebhook,
  type NotificationEvent,
} from '../src/notifications'

const NOW = Math.floor(Date.now() / 1000)
const config: WorkerConfig = {
  probes: [{ id: 'a' }, { id: 'b' }],
  monitors: [
    {
      id: 'web',
      name: 'Web "测试"',
      target: 'https://example.test',
      method: 'GET',
      probes: ['a', 'b'],
      notificationTemplateId: 'notice',
    },
  ],
  notificationTemplates: [
    {
      id: 'notice',
      name: 'Webhook',
      type: 'webhook',
      webhook: {
        url: 'https://hooks.test/secret-path',
        method: 'POST',
        payloadType: 'json',
        headers: { Authorization: 'private-webhook-secret' },
        payload: { text: '$MSG', nested: { name: '$MONITOR', status: '$STATUS' } },
        timeout: 100,
      },
    },
  ],
}
let mf: Miniflare
let env: ProbeEnv
let receiver: Server
beforeAll(async () => {
  const Bytes = Uint8Array as any
  Bytes.prototype.toHex ??= function () { return Buffer.from(this).toString('hex') }
  Bytes.fromHex ??= (value: string) => Uint8Array.from(Buffer.from(value, 'hex'))
  mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: '2025-04-02',
    d1Databases: ['UPTIMEFLARE_D1'],
  })
  env = { UPTIMEFLARE_D1: (await mf.getD1Database('UPTIMEFLARE_D1')) as unknown as D1Database }
  const schema = readFileSync(new URL('../../init.sql', import.meta.url), 'utf8')
  for (const statement of schema.split(';').filter((value) => value.trim()))
    await env.UPTIMEFLARE_D1.prepare(statement).run()
}, 30000)
beforeEach(async () => {
  for (const table of [
    'uptimeflare',
    'notification_outbox',
    'notification_state',
    'notification_observations',
    'probe_latest',
    'probe_samples',
    'probe_days',
    'probe_sample_details',
    'probe_buckets',
    'probe_totals',
    'probe_bucket_stages',
    'probe_stage_totals',
  ])
    await env.UPTIMEFLARE_D1.prepare(`DELETE FROM ${table}`).run()
})
afterAll(async () => {
  await mf?.dispose()
  if (receiver?.listening) await new Promise<void>((resolve) => receiver.close(() => resolve()))
})
const sender = () => vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }))
async function result(probe: string, time: number, up: boolean) {
  await persistBatch(env, probe, [
    {
      monitor_id: 'web',
      time,
      up,
      latency_ms: 10,
      ...(up ? {} : { stage: 'dns' as const, code: 'dns_not_found' }),
    },
  ])
}
async function queued() {
  return (
    await env.UPTIMEFLARE_D1.prepare(
      'SELECT * FROM notification_outbox ORDER BY sequence'
    ).all<any>()
  ).results
}

it('uses durable source webhooks with 5-minute checks, target grace and recovery gating', async () => {
  const send=sender()
  const source: WorkerConfig = {
    monitors:[{id:'native',name:'Native',target:'https://example.test',intervalSeconds:300,notificationGracePeriodSeconds:60}],
    notification:{gracePeriod:20,webhook:[config.notificationTemplates![0].webhook,{...config.notificationTemplates![0].webhook,url:'https://second.test/hook'}]},
    maintenances:[],
  }
  async function sample(time:number,up:boolean) {
    const state=new CompactedMonitorStateWrapper(null)
    state.appendIncident('native',{start:[NOW],end:up?time:null,error:['[tcp/refused] Connection refused']})
    state.appendLatency('native',{time,ping:1,loc:'SIN'})
    await setToStore(env,'state',state.getCompactedStateStr())
  }
  await sample(NOW,false); await runNotifications(env,source,NOW+1,send)
  await runNotifications(env,source,NOW+70,send)
  expect(send).not.toHaveBeenCalled()
  await sample(NOW+300,false); await runNotifications(env,source,NOW+301,send)
  expect(send).toHaveBeenCalledTimes(2)
  await runNotifications(env,source,NOW+360,send)
  expect(send).toHaveBeenCalledTimes(2)
  await sample(NOW+600,true); await runNotifications(env,source,NOW+601,send)
  expect(send).toHaveBeenCalledTimes(4)
  expect(JSON.parse(send.mock.calls[2][1]!.body as string).nested.status).toBe('up')
})

it('does not send recovery for a transient failure that never passes grace', async () => {
  const send=sender(); const delayed={...config,notification:{gracePeriod:1}}
  await result('a',NOW,false); await result('b',NOW,false); await runNotifications(env,delayed,NOW+1,send)
  await result('a',NOW+30,true); await result('b',NOW+30,true); await runNotifications(env,delayed,NOW+31,send)
  expect(send).not.toHaveBeenCalled()
})

it('never logs source webhook credentials or response bodies and rejects credential redirects', async () => {
  const logs=vi.spyOn(console,'log').mockImplementation(()=>{}); const errors=vi.spyOn(console,'error').mockImplementation(()=>{})
  const send=vi.fn().mockResolvedValue(new Response('private-remote-response',{status:302}))
  vi.stubGlobal('fetch',send)
  try {
    await webhookNotify(config.notificationTemplates![0].webhook,'private-message')
    expect(send.mock.calls[0][1].redirect).toBe('manual')
    const output=JSON.stringify([...logs.mock.calls,...errors.mock.calls])
    for(const secret of ['private-message','secret-path','private-webhook-secret','private-remote-response']) expect(output).not.toContain(secret)
  } finally { logs.mockRestore(); errors.mockRestore(); vi.unstubAllGlobals() }
})

it('applies elapsed sample grace, ignores reused results, and suppresses transient recovery alerts', async () => {
  const send=sender()
  const delayed={...config,notification:{gracePeriod:1}}
  await result('a',NOW,false); await result('b',NOW,false)
  await runNotifications(env,delayed,NOW+1,send)
  await runNotifications(env,delayed,NOW+70,send)
  expect(send).not.toHaveBeenCalled()
  await result('a',NOW+60,false); await result('b',NOW+60,false)
  await runNotifications(env,delayed,NOW+71,send)
  expect(send).toHaveBeenCalledTimes(1)
  await result('a',NOW+80,true); await result('b',NOW+80,true)
  await runNotifications(env,delayed,NOW+81,send)
  expect(send).toHaveBeenCalledTimes(2)
  expect(JSON.parse(send.mock.calls[1][1]!.body as string).nested.status).toBe('up')
})

it('resets unnotified grace when mixed results interrupt an outage and uses target overrides', async () => {
  const send=sender()
  const delayed={...config,notification:{gracePeriod:20},monitors:[{...config.monitors[0],notificationGracePeriodSeconds:60}]}
  await result('a',NOW,false); await result('b',NOW,false); await runNotifications(env,delayed,NOW+1,send)
  await result('a',NOW+30,true); await runNotifications(env,delayed,NOW+31,send)
  await result('a',NOW+40,false); await result('b',NOW+40,false); await runNotifications(env,delayed,NOW+41,send)
  await result('a',NOW+80,false); await result('b',NOW+80,false); await runNotifications(env,delayed,NOW+81,send)
  expect(send).not.toHaveBeenCalled()
  await result('a',NOW+100,false); await result('b',NOW+100,false); await runNotifications(env,delayed,NOW+101,send)
  expect(send).toHaveBeenCalledTimes(1)
})

it('suppresses maintenance and excluded targets, and cancels pending retry jobs during maintenance', async () => {
  const send=vi.fn<typeof fetch>().mockRejectedValue(new Error('offline'))
  await result('a',NOW,false); await result('b',NOW,false); await runNotifications(env,config,NOW+1,send)
  expect(await queued()).toHaveLength(1)
  const maintenance={...config,maintenances:[{body:'Upgrade',start:NOW,end:NOW+300,monitors:['web']}]}
  await runNotifications(env,maintenance,NOW+2,send)
  expect(await queued()).toHaveLength(0)
  expect(send).toHaveBeenCalledTimes(1)
  await result('a',NOW+310,true); await result('b',NOW+310,true)
  await runNotifications(env,{...config,notification:{skipNotificationIds:['web']}},NOW+311,send)
  expect(send).toHaveBeenCalledTimes(1)
})

it('ignores missing, stale, mixed and replayed historical results, notifies fresh all-failure and recovery once', async () => {
  const send = sender()
  await result('a', NOW - 10000, false)
  await runNotifications(env, config, NOW, send)
  expect(send).not.toHaveBeenCalled()
  await result('a', NOW, true)
  await runNotifications(env, config, NOW + 1, send)
  expect(send).not.toHaveBeenCalled()
  await result('b', NOW + 2, false)
  await runNotifications(env, config, NOW + 3, send)
  expect(send).not.toHaveBeenCalled()
  await result('a', NOW + 4, false)
  await runNotifications(env, config, NOW + 5, send)
  expect(send).toHaveBeenCalledTimes(1)
  const body = JSON.parse(send.mock.calls[0][1]!.body as string)
  expect(body.nested).toEqual({ name: 'Web "测试"', status: 'down' })
  await runNotifications(env, config, NOW + 6, send)
  await result('a', NOW - 100, true)
  await runNotifications(env, config, NOW + 7, send)
  expect(send).toHaveBeenCalledTimes(1)
  await result('a', NOW + 8, true)
  await result('b', NOW + 8, true)
  await runNotifications(env, config, NOW + 9, send)
  expect(send).toHaveBeenCalledTimes(2)
  expect(JSON.parse(send.mock.calls[1][1]!.body as string).nested.status).toBe('up')
  expect(await queued()).toHaveLength(0)
})

it('keeps unknown probes separate and alerts on failure from the only reporting probe', async () => {
  const send = sender()
  await result('a', NOW, false)
  await runNotifications(env, config, NOW + 1, send)
  expect(send).toHaveBeenCalledTimes(1)
  await runNotifications(env, config, NOW + 1000, send)
  expect(send).toHaveBeenCalledTimes(1)
  await result('a', NOW + 1001, true)
  await runNotifications(env, config, NOW + 1002, send)
  expect(send).toHaveBeenCalledTimes(2)
})

it('atomically deduplicates concurrent transitions and concurrent dispatchers', async () => {
  await Promise.all(
    Array.from({ length: 4 }, () =>
      queueNotification(env, config.monitors[0], 'down', NOW, 'dns/timeout', NOW)
    )
  )
  expect(await queued()).toHaveLength(1)
  const send = sender()
  await Promise.all([
    deliverNotifications(env, config, NOW, send),
    deliverNotifications(env, config, NOW, send),
  ])
  expect(send).toHaveBeenCalledTimes(1)
  expect(await queued()).toHaveLength(0)
})

it('rolls back state when event persistence fails so the next attempt can enqueue the alert', async () => {
  await env.UPTIMEFLARE_D1.prepare(
    "CREATE TRIGGER reject_notification BEFORE INSERT ON notification_outbox BEGIN SELECT RAISE(ABORT,'test failure'); END"
  ).run()
  try {
    await expect(
      queueNotification(env, config.monitors[0], 'down', NOW, 'dns/timeout', NOW)
    ).rejects.toThrow()
    expect(await queued()).toHaveLength(0)
    expect(
      (await env.UPTIMEFLARE_D1.prepare('SELECT * FROM notification_state').all()).results
    ).toHaveLength(0)
  } finally {
    await env.UPTIMEFLARE_D1.prepare('DROP TRIGGER reject_notification').run()
  }
  await queueNotification(env, config.monitors[0], 'down', NOW, 'dns/timeout', NOW)
  expect(await queued()).toHaveLength(1)
})

it('retries durably in order with the same event identity and cancels disabled targets', async () => {
  await queueNotification(env, config.monitors[0], 'down', NOW, 'tcp/refused', NOW)
  const send = vi
    .fn<typeof fetch>()
    .mockRejectedValueOnce(new Error('private-url-credential'))
    .mockResolvedValue(new Response(null, { status: 204 }))
  await deliverNotifications(env, config, NOW, send)
  const jobs = await queued()
  expect(jobs).toHaveLength(1)
  expect(jobs[0].attempts).toBe(1)
  expect(jobs[0].next_attempt_at).toBe(NOW + 60)
  await queueNotification(env, config.monitors[0], 'up', NOW + 1, 'OK', NOW + 1)
  await deliverNotifications(env, config, NOW + 2, send)
  expect(send).toHaveBeenCalledTimes(1)
  await deliverNotifications(env, config, NOW + 60, send)
  expect(send).toHaveBeenCalledTimes(2)
  expect(new Headers(send.mock.calls[0][1]!.headers).get('Idempotency-Key')).toBe(
    new Headers(send.mock.calls[1][1]!.headers).get('Idempotency-Key')
  )
  await deliverNotifications(env, config, NOW + 61, send)
  expect(send).toHaveBeenCalledTimes(3)
  await queueNotification(env, config.monitors[0], 'down', NOW + 62, 'tls/certificate', NOW + 62)
  await runNotifications(
    env,
    { ...config, monitors: [{ ...config.monitors[0], notificationTemplateId: undefined }] },
    NOW + 63,
    send
  )
  expect(await queued()).toHaveLength(0)
  expect(send).toHaveBeenCalledTimes(3)
})

it('sends real HTTP JSON, query parameters and form requests with safe string substitution', async () => {
  const requests: { url: string; body: string; authorization?: string; event?: string }[] = []
  receiver = createServer(async (request, response) => {
    let body = ''
    for await (const chunk of request) body += chunk
    requests.push({
      url: request.url!,
      body,
      authorization: request.headers.authorization,
      event: request.headers['x-uptimeflare-event-id'] as string,
    })
    response.writeHead(204).end()
  })
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`
  const event: NotificationEvent = {
    eventId: 'event-test',
    monitorName: 'Host "quoted"\nline',
    status: 'down',
    time: new Date(NOW * 1000).toISOString(),
    reason: 'dns/timeout',
    duration: 0,
    message: 'A & B "text"',
  }
  const webhook = config.notificationTemplates![0].webhook
  await sendTemplateWebhook({ ...webhook, url, timeout: 5000 }, event)
  expect(JSON.parse(requests[0].body).nested.name).toBe(event.monitorName)
  expect(requests[0].authorization).toBe('private-webhook-secret')
  expect(requests[0].event).toBe('event-test')
  expect(webhook.payload.nested.name).toBe('$MONITOR')
  await sendTemplateWebhook(
    {
      ...webhook,
      url,
      method: 'GET',
      payloadType: 'param',
      payload: { text: '$MSG' },
      timeout: 5000,
    },
    event
  )
  expect(new URL(requests[1].url, url).searchParams.get('text')).toBe(event.message)
  await sendTemplateWebhook(
    {
      ...webhook,
      url,
      payloadType: 'x-www-form-urlencoded',
      payload: { text: '$MSG' },
      timeout: 5000,
    },
    event
  )
  expect(new URLSearchParams(requests[2].body).get('text')).toBe(event.message)
  await new Promise<void>((resolve) => receiver.close(() => resolve()))
})

it('treats redirects and non-success responses as failures and bounds hanging requests', async () => {
  const event: NotificationEvent = {
    eventId: 'test',
    monitorName: 'host',
    status: 'down',
    time: 'now',
    reason: 'dns',
    duration: 0,
    message: 'down',
  }
  const webhook = config.notificationTemplates![0].webhook
  const redirect = vi
    .fn<typeof fetch>()
    .mockResolvedValue(
      new Response(null, { status: 302, headers: { Location: 'https://untrusted.test/' } })
    )
  await expect(sendTemplateWebhook(webhook, event, redirect)).rejects.toThrow()
  expect(redirect.mock.calls[0][1]!.redirect).toBe('manual')
  const hang = vi
    .fn<typeof fetch>()
    .mockImplementation(
      (_url, options) =>
        new Promise((_resolve, reject) =>
          options!.signal!.addEventListener('abort', () => reject(new Error('aborted')))
        )
    )
  await expect(sendTemplateWebhook({ ...webhook, timeout: 10 }, event, hang)).rejects.toThrow(
    'aborted'
  )
})
