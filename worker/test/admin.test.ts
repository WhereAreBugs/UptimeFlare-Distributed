import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import { readFileSync } from 'node:fs'
import { handleAdminRequest, validateSettings, type AdminEnv } from '../src/admin'
import { getRuntimeConfig } from '../src/settings'
import { handleProbeRequest } from '../src/probes'
import type { WorkerConfig } from '../../types/config'

let mf: Miniflare
let env: AdminEnv
const PASSWORD = 'test-admin-password-with-32-characters'
const fallback: WorkerConfig = {
  probes: [{ id: 'a', name: 'A' }],
  monitors: [
    { id: 'web', name: 'Web', target: 'https://initial.example', method: 'GET', probes: ['a'] },
  ],
}
const TOKEN = 'independent-probe-a-secret-123456'
let address = 0
function request(
  path: string,
  method: string,
  body?: unknown,
  cookie = '',
  origin = 'https://status.test',
  ip?: string
) {
  return new Request(`https://status.test/api/admin/${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Origin: origin,
      Cookie: cookie,
      'CF-Connecting-IP': ip ?? `test-${++address}`,
    },
    ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }),
  })
}
async function login() {
  const response = await handleAdminRequest(
    request('login', 'POST', { password: PASSWORD }),
    env,
    fallback
  )
  expect(response.status).toBe(200)
  expect(response.headers.get('Set-Cookie')).toContain('Secure; HttpOnly; SameSite=Strict')
  return response.headers.get('Set-Cookie')!.split(';')[0]
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
    ADMIN_PASSWORD: PASSWORD,
    ADMIN_SESSION_SECRET: 'session-signing-test-secret-at-least-32-characters',
  }
  const schema = readFileSync(new URL('../../init.sql', import.meta.url), 'utf8')
  for (const statement of schema.split(';').filter((s) => s.trim()))
    await env.UPTIMEFLARE_D1.prepare(statement).run()
}, 30000)
afterAll(async () => {
  await mf?.dispose()
})

describe('authenticated web configuration with actual D1', () => {
  it('rejects anonymous reads/writes, wrong passwords, cross-origin login and missing secrets', async () => {
    expect((await handleAdminRequest(request('config', 'GET'), env, fallback)).status).toBe(401)
    expect((await handleAdminRequest(request('config', 'PUT', {}), env, fallback)).status).toBe(401)
    expect(
      (await handleAdminRequest(request('login', 'POST', { password: 'wrong' }), env, fallback))
        .status
    ).toBe(401)
    expect(
      (
        await handleAdminRequest(
          request('login', 'POST', { password: PASSWORD }, '', 'https://evil.test'),
          env,
          fallback
        )
      ).status
    ).toBe(403)
    expect(
      (
        await handleAdminRequest(
          request('login', 'POST', { password: PASSWORD }),
          { ...env, ADMIN_PASSWORD: undefined },
          fallback
        )
      ).status
    ).toBe(503)
  })
  it('signs sessions, rejects tampering and expires all sessions on password rotation', async () => {
    const cookie = await login()
    const response = await handleAdminRequest(
      request('config', 'GET', undefined, cookie),
      env,
      fallback
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ revision: 0, monitors: fallback.monitors })
    expect(
      (
        await handleAdminRequest(
          request(
            'config',
            'GET',
            undefined,
            cookie.slice(0, -1) + (cookie.endsWith('a') ? 'b' : 'a')
          ),
          env,
          fallback
        )
      ).status
    ).toBe(401)
    expect(
      (
        await handleAdminRequest(
          request('config', 'GET', undefined, cookie),
          { ...env, ADMIN_PASSWORD: PASSWORD + '-rotated' },
          fallback
        )
      ).status
    ).toBe(401)
  })
  it('persists config, refuses conflicting edits and distributes changes to probes', async () => {
    const cookie = await login()
    const value = {
      ...fallback,
      revision: 0,
      notificationTemplates: [
        {
          id: 'notice',
          name: '故障通知',
          type: 'webhook',
          webhook: {
            url: 'https://private-hook.example/secret-path',
            payloadType: 'json',
            headers: { Authorization: 'private-webhook-header' },
            payload: { text: '$MSG' },
          },
        },
      ],
      monitors: [
        {
          ...fallback.monitors[0],
          target: 'https://edited.example',
          headers: { Authorization: 'private-target-header' },
          notificationTemplateId: 'notice',
        },
      ],
    }
    const write = await handleAdminRequest(request('config', 'PUT', value, cookie), env, fallback)
    expect(write.status).toBe(200)
    expect(await write.json()).toMatchObject({ revision: 1 })
    expect(
      (await handleAdminRequest(request('config', 'PUT', value, cookie), env, fallback)).status
    ).toBe(409)
    expect(
      (
        await handleAdminRequest(
          request('config', 'PUT', { ...value, revision: 1 }, cookie, 'https://evil.test'),
          env,
          fallback
        )
      ).status
    ).toBe(403)
    const runtime = await getRuntimeConfig(env, fallback)
    expect(runtime.monitors[0].target).toBe('https://edited.example')
    expect(runtime.notificationTemplates?.[0].name).toBe('故障通知')
    expect(runtime.monitors[0].notificationTemplateId).toBe('notice')
    const probe = await handleProbeRequest(
      new Request('https://status.test/api/probes/config', {
        headers: { Authorization: 'Bearer ' + TOKEN },
      }),
      env,
      runtime.monitors
    )
    expect(probe.status).toBe(200)
    const probeConfig = await probe.json()
    expect(JSON.stringify(probeConfig)).not.toContain('private-webhook-header')
    expect(JSON.stringify(probeConfig)).not.toContain('private-hook.example')
    expect(probeConfig).toMatchObject({
      probe_id: 'a',
      monitors: [{ target: 'https://edited.example' }],
    })
    const privateRead = await handleAdminRequest(request('config', 'GET'), env, fallback)
    expect(privateRead.status).toBe(401)
    expect(await privateRead.text()).not.toContain('private-target-header')
    const logout = await handleAdminRequest(request('logout', 'POST', {}, cookie), env, fallback)
    expect(logout.headers.get('Set-Cookie')).toContain('Max-Age=0')
  })
  it('bounds login attempts by hashed source address and time window', async () => {
    for (let i = 0; i < 10; i++)
      expect(
        (
          await handleAdminRequest(
            request(
              'login',
              'POST',
              { password: 'wrong' },
              '',
              'https://status.test',
              'one-source'
            ),
            env,
            fallback
          )
        ).status
      ).toBe(401)
    const limited = await handleAdminRequest(
      request('login', 'POST', { password: PASSWORD }, '', 'https://status.test', 'one-source'),
      env,
      fallback
    )
    expect(limited.status).toBe(429)
    expect(limited.headers.get('Retry-After')).toBe('900')
    const row = await env.UPTIMEFLARE_D1.prepare(
      'SELECT address FROM admin_login_attempts LIMIT 1'
    ).first<{ address: string }>()
    expect(row?.address).toMatch(/^[a-f0-9]{64}$/)
  })
  it('bounds bodies and never echoes parsing/SQL errors or configured secrets', async () => {
    const cookie = await login()
    const response = await handleAdminRequest(
      request('config', 'PUT', 'x'.repeat(512 * 1024 + 1), cookie),
      env,
      fallback
    )
    expect(response.status).toBe(400)
    expect(await response.text()).toContain('512 KiB')
    const bad = await handleAdminRequest(
      request('config', 'PUT', '{"secret":"PRIVATE', cookie),
      env,
      fallback
    )
    expect(bad.status).toBe(400)
    expect(await bad.text()).not.toContain('PRIVATE')
  })
})

describe('configuration validation', () => {
  it('rejects unregistered identities and unsupported targets', () => {
    const validate = (value: unknown) => validateSettings(value, new Set(['a']))
    expect(() => validate({ ...fallback, probes: [{ id: 'unknown' }] })).toThrow()
    expect(() =>
      validate({
        ...fallback,
        monitors: [{ ...fallback.monitors[0], target: 'file:///etc/passwd' }],
      })
    ).toThrow()
    expect(() =>
      validate({
        ...fallback,
        monitors: [{ ...fallback.monitors[0], target: 'https://user:secret@example.com' }],
      })
    ).toThrow()
    expect(() =>
      validate({
        ...fallback,
        monitors: [{ ...fallback.monitors[0], headers: { Test: 'bad\r\nheader' } }],
      })
    ).toThrow()
    expect(() =>
      validate({ ...fallback, monitors: [{ ...fallback.monitors[0], probes: [] }] })
    ).toThrow()
  })
  it('automatically allocates missing and repeated identities while preserving existing history references', () => {
    const value = validateSettings(
      {
        ...fallback,
        probes: [...fallback.probes!, ...fallback.probes!],
        monitors: [
          fallback.monitors[0],
          { ...fallback.monitors[0] },
          { ...fallback.monitors[0], id: undefined },
        ],
      },
      new Set(['a'])
    )
    expect(value.monitors[0].id).toBe(fallback.monitors[0].id)
    expect(new Set(value.monitors.map((monitor) => monitor.id)).size).toBe(3)
    expect(value.monitors.slice(1).every((monitor) => monitor.id.startsWith('monitor-'))).toBe(true)
    expect(value.probes?.filter((probe) => probe.id === 'a')).toHaveLength(1)
  })
  it('validates webhook templates and target references without exposing private delivery configuration to probes', async () => {
    const template = {
      name: '通知',
      type: 'webhook',
      webhook: {
        url: 'https://hooks.example.test/private',
        method: 'POST',
        payloadType: 'json',
        headers: { Authorization: 'private-webhook-credential' },
        payload: { text: '$MSG' },
      },
    }
    const settings = validateSettings(
      { ...fallback, notificationTemplates: [template] },
      new Set(['a'])
    )
    const id = settings.notificationTemplates![0].id
    const configured = validateSettings(
      { ...settings, monitors: [{ ...fallback.monitors[0], notificationTemplateId: id }] },
      new Set(['a'])
    )
    expect(configured.notificationTemplates![0].webhook.headers).toEqual(template.webhook.headers)
    const probe = await handleProbeRequest(
      new Request('https://status.test/api/probes/config', {
        headers: { Authorization: `Bearer ${TOKEN}` },
      }),
      env,
      configured.monitors
    )
    const body = await probe.text()
    expect(body).not.toContain('private-webhook-credential')
    expect(body).not.toContain('hooks.example.test')
    expect(body).not.toContain('notificationTemplateId')
    expect(() =>
      validateSettings({ ...configured, notificationTemplates: [] }, new Set(['a']))
    ).toThrow()
    for (const webhook of [
      { ...template.webhook, url: 'file:///etc/passwd' },
      { ...template.webhook, method: 'GET' },
      { ...template.webhook, headers: { Test: 'bad\r\nheader' } },
      { ...template.webhook, timeout: 30001 },
    ])
      expect(() =>
        validateSettings(
          { ...fallback, notificationTemplates: [{ ...template, webhook }] },
          new Set(['a'])
        )
      ).toThrow()
  })
  it('drops nonallowlisted executable configuration and accepts explicit TCP port 443', () => {
    const config = validateSettings(
      {
        ...fallback,
        callbacks: { onIncident: 'code' },
        monitors: [
          {
            ...fallback.monitors[0],
            method: 'TCP_PING',
            target: 'example.com:443',
            checkProxy: 'https://unwanted',
          },
        ],
      },
      new Set(['a'])
    )
    expect(config.monitors[0].target).toBe('example.com:443')
    expect(config.monitors[0].checkProxy).toBe('https://unwanted')
    expect((config as any).callbacks).toBeUndefined()
  })
})
