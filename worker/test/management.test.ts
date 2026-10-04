import { beforeAll, beforeEach, afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { Miniflare } from 'miniflare'
import { readFileSync } from 'node:fs'
import { handleAdminRequest, type AdminEnv } from '../src/admin'
import { handleManagementRequest } from '../src/management'
import { getSettings } from '../src/settings'
import { handleProbeRequest } from '../src/probes'
import { setToStore, CompactedMonitorStateWrapper } from '../src/store'
import type { WorkerConfig } from '../../types/config'
import type { ManagementTokenCreated, ManagementTokenList } from '../../types/management'

const PASSWORD = 'test-admin-management-password-32-characters'
const PROBE = 'independent-test-probe-management-secret'
const fallback: WorkerConfig = {
  probes: [{ id: 'a', name: 'Private probe name' }, { id: 'b' }],
  monitors: [
    {
      id: 'one',
      name: 'First',
      target: 'https://private.example/secret-path',
      method: 'GET',
      probes: ['a', 'b'],
      intervalSeconds: 60,
      headers: { Authorization: 'private-target-header' },
    },
    {
      id: 'two',
      name: 'Second',
      target: 'https://other-private.example',
      method: 'GET',
      probes: ['a'],
    },
    { id: 'three', name: 'Third', target: 'https://outside.example', method: 'GET', probes: ['a'] },
  ],
  page: {
    group: { Alpha: ['one', 'two'], Beta: ['three'] },
    customFooter: 'private-footer-content',
  },
}
let mf: Miniflare, env: AdminEnv, cookie: string
function admin(path: string, method = 'GET', data?: unknown, headers: Record<string, string> = {}) {
  return handleAdminRequest(
    new Request(`https://status.test/api/admin/${path}`, {
      method,
      headers: {
        Origin: 'https://status.test',
        Cookie: cookie,
        'Content-Type': 'application/json',
        ...headers,
      },
      ...(data !== undefined && { body: JSON.stringify(data) }),
    }),
    env,
    fallback
  )
}
function manage(
  token: string | undefined,
  path = 'status',
  method = 'GET',
  data?: unknown,
  customEnv = env,
  headers: Record<string, string> = {}
) {
  return handleManagementRequest(
    new Request(`https://status.test/api/manage/${path}`, {
      method,
      headers: {
        ...(token && { Authorization: `Bearer ${token}` }),
        ...(data !== undefined && { 'Content-Type': 'application/json' }),
        ...headers,
      },
      ...(data !== undefined && { body: JSON.stringify(data) }),
    }),
    customEnv,
    fallback
  )
}
async function create(names = ['Alpha'], permissions?: string[]) {
  const settings = await getSettings(env, fallback)
  const response = await admin('tokens', 'POST', {
    name: 'Automation',
    groupIds: names.map((name) => settings.groupIds[name]),
    ...(permissions && { permissions }),
  })
  expect(response.status).toBe(201)
  return response.json() as Promise<ManagementTokenCreated>
}
async function save(change: (settings: any) => any) {
  return admin('config', 'PUT', change(await getSettings(env, fallback)))
}
async function markers() {
  return (
    await env.UPTIMEFLARE_D1.prepare(
      'SELECT * FROM notification_observations ORDER BY monitor_id'
    ).all()
  ).results
}
function interleave(action: () => Promise<void>) {
  let intercepted = false
  return {
    ...env,
    UPTIMEFLARE_D1: new Proxy(env.UPTIMEFLARE_D1, {
      get(target, property) {
        if (property === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            if (!intercepted) {
              intercepted = true
              await action()
            }
            return target.batch(statements)
          }
        const value = Reflect.get(target, property)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }),
  }
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
    PROBE_TOKENS: JSON.stringify({ a: PROBE, b: 'other-private-probe-secret' }),
    ADMIN_PASSWORD: PASSWORD,
    ADMIN_SESSION_SECRET: 'session-management-signing-secret-more-than-32',
  }
  for (const statement of readFileSync(new URL('../../init.sql', import.meta.url), 'utf8')
    .split(';')
    .filter((value) => value.trim()))
    await env.UPTIMEFLARE_D1.prepare(statement).run()
  const response = await admin('login', 'POST', { password: PASSWORD })
  expect(response.status).toBe(200)
  cookie = response.headers.get('Set-Cookie')!.split(';')[0]
}, 30000)
beforeEach(async () => {
  await env.UPTIMEFLARE_D1.batch(
    [
      'admin_config',
      'management_tokens',
      'notification_observations',
      'notification_state',
      'notification_outbox',
      'notification_deliveries',
      'monitor_schedule',
      'probe_latest',
      'uptimeflare',
      'probe_samples',
      'probe_buckets',
      'probe_days',
      'probe_totals',
      'probe_stage_totals',
      'probe_bucket_stages',
      'probe_sample_details',
    ].map((table) => env.UPTIMEFLARE_D1.prepare(`DELETE FROM ${table}`))
  )
  expect((await admin('config')).status).toBe(200)
})
afterAll(async () => {
  await mf?.dispose()
})
afterEach(() => vi.restoreAllMocks())

describe('scoped management tokens with actual D1', () => {
  it('initializes legacy group IDs exactly once without changing revision/config, including concurrent reads', async () => {
    await env.UPTIMEFLARE_D1.prepare('UPDATE admin_config SET revision=7,value=?')
      .bind(
        JSON.stringify({ ...fallback, privateExtension: 'keep-this', probeStaleAfterSeconds: 900 })
      )
      .run()
    const [a, b] = (await Promise.all(
      (await Promise.all([admin('config'), admin('config')])).map((response) => response.json())
    )) as any[]
    expect(a.groupIds).toEqual(b.groupIds)
    expect(a.revision).toBe(7)
    const raw = await env.UPTIMEFLARE_D1.prepare(
      'SELECT revision,value FROM admin_config'
    ).first<any>()
    expect(raw.revision).toBe(7)
    expect(JSON.parse(raw.value)).toMatchObject({
      privateExtension: 'keep-this',
      probeStaleAfterSeconds: 900,
      monitors: fallback.monitors,
    })
    expect(a._groupIds).toBeUndefined()
  })
  it('returns plaintext once, stores only SHA256, lists safe metadata and separates Cookie/Bearer/Basic authentication', async () => {
    const created = await create()
    expect(created.token).toMatch(/^ufm_[a-f0-9]{64}$/)
    expect(created.entry.permissions).toEqual(['query', 'control'])
    const stored = await env.UPTIMEFLARE_D1.prepare('SELECT * FROM management_tokens').first<any>()
    expect(stored.token_hash).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(stored)).not.toContain(created.token)
    const listing = (await (await admin('tokens')).json()) as ManagementTokenList
    expect(listing.groups).toHaveLength(2)
    expect(listing.tokens[0].groupNames).toEqual(['Alpha'])
    expect(JSON.stringify(listing)).not.toMatch(/token_hash|ufm_|private-/)
    expect(
      (
        await admin('tokens', 'GET', undefined, {
          Cookie: '',
          Authorization: `Bearer ${created.token}`,
        })
      ).status
    ).toBe(401)
    expect(
      (await admin('config', 'GET', undefined, { Authorization: `Bearer ${created.token}` })).status
    ).toBe(401)
    expect(
      (
        await admin('tokens', 'GET', undefined, {
          Authorization: 'Basic external-password-protection',
        })
      ).status
    ).toBe(200)
    expect(
      (await manage(undefined, 'groups', 'GET', undefined, env, { Cookie: cookie })).status
    ).toBe(401)
    expect((await admin('tokens', 'POST', {}, { Origin: 'https://evil.test' })).status).toBe(403)
    expect(
      (
        await manage(created.token, 'groups', 'GET', undefined, env, {
          Origin: 'https://evil.test',
        })
      ).status
    ).toBe(403)
    expect((await manage(created.token, 'status?token=anything')).status).toBe(400)
    expect((await manage(created.token, 'config')).status).toBe(404)
    expect((await manage(created.token, 'status', 'POST')).status).toBe(405)
  })
  it('validates strict creation fields, permissions, expiry and current group scope', async () => {
    const ids = Object.values((await getSettings(env, fallback)).groupIds)
    for (const data of [
      { name: 'x', groupIds: ids, permissions: [] },
      { name: 'x', groupIds: ids, permissions: ['admin'] },
      { name: 'x', groupIds: ids, permissions: ['query', 'query'] },
      { name: 'x', groupIds: [] },
      { name: 'x', groupIds: [crypto.randomUUID()] },
      { name: 'x', groupIds: ids, token: 'chosen' },
      { name: 'x', groupIds: ids, expiresAt: Math.floor(Date.now() / 1000) - 1 },
      { name: 'x'.repeat(201), groupIds: ids },
    ])
      expect((await admin('tokens', 'POST', data)).status).toBe(400)
    const query = await create(['Alpha'], ['query'])
    expect((await manage(query.token, 'groups')).status).toBe(200)
    expect((await manage(query.token, 'monitors/one/disable', 'POST')).status).toBe(403)
    const control = await create(['Alpha'], ['control'])
    expect((await manage(control.token, 'groups')).status).toBe(200)
    expect((await manage(control.token)).status).toBe(403)
    expect(
      (await manage(control.token, 'monitors/one/disable', 'POST', { paused: false })).status
    ).toBe(400)
  })
  it('accepts zero-byte POST streams without MIME while rejecting nonempty text and accepting JSON objects', async () => {
    const token = await create()
    const empty = new Request('https://status.test/api/manage/monitors/one/disable', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.token}` },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close()
        },
      }),
      duplex: 'half',
    } as RequestInit)
    expect(empty.body).not.toBeNull()
    expect(empty.headers.get('Content-Type')).toBeNull()
    expect((await handleManagementRequest(empty, env, fallback)).status).toBe(200)
    expect((await getSettings(env, fallback)).monitors[0].paused).toBe(true)
    const text = new Request('https://status.test/api/manage/monitors/one/enable', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'text/plain' },
      body: 'nonempty text',
    })
    expect((await handleManagementRequest(text, env, fallback)).status).toBe(400)
    expect((await getSettings(env, fallback)).monitors[0].paused).toBe(true)
    expect((await manage(token.token, 'monitors/one/enable', 'POST', {})).status).toBe(200)
    expect((await getSettings(env, fallback)).monitors[0].paused).toBe(false)
  })

  it('returns group union with exact TTL, public aggregate colors and maintenance, excluding private fields', async () => {
    const token = await create()
    const now = Math.floor(Date.now() / 1000)
    vi.spyOn(Date, 'now').mockReturnValue(now * 1000)
    await env.UPTIMEFLARE_D1.batch([
      env.UPTIMEFLARE_D1.prepare('INSERT INTO probe_latest VALUES(?,?,?,?,?,?,?,?)').bind(
        'a',
        'one',
        now - 120,
        1,
        12,
        'http',
        '200',
        'private-target-header'
      ),
      env.UPTIMEFLARE_D1.prepare('INSERT INTO probe_latest VALUES(?,?,?,?,?,?,?,?)').bind(
        'a',
        'two',
        now - 601,
        0,
        20,
        'tls',
        'certificate',
        'https://private.example/secret-path'
      ),
      env.UPTIMEFLARE_D1.prepare('INSERT INTO probe_latest VALUES(?,?,?,?,?,?,?,?)').bind(
        'a',
        'three',
        now,
        1,
        33,
        '',
        '',
        'private-probe'
      ),
    ])
    const data = (await (await manage(token.token)).json()) as any
    expect(data.monitors.map((monitor: any) => monitor.id)).toEqual(['one', 'two'])
    expect(data.monitors[0]).toMatchObject({
      status: 'up',
      reachableProbes: 1,
      unknownProbes: 1,
      latencyMs: 12,
    })
    expect(data.monitors[1]).toMatchObject({ status: 'unknown', latencyMs: null })
    expect(JSON.stringify(data)).not.toMatch(
      /private|https:|headers|message|location|history|token_hash/
    )
    expect((await manage(token.token, 'monitors/three/status')).status).toBe(403)
    expect(
      (
        await manage(
          token.token,
          `groups/${(await getSettings(env, fallback)).groupIds.Beta}/status`
        )
      ).status
    ).toBe(403)
    const union = await create(['Alpha', 'Beta'])
    expect(((await (await manage(union.token)).json()) as any).monitors).toHaveLength(3)
    expect(
      (
        await save((settings) => ({
          ...settings,
          maintenances: [
            { body: 'Maintenance', start: now - 10, end: now + 600, monitors: ['one'] },
          ],
        }))
      ).status
    ).toBe(200)
    expect(((await (await manage(token.token)).json()) as any).monitors[0].status).toBe(
      'maintenance'
    )
  })
  it('controls groups/single targets transactionally, retains configuration/history and accepts paused backlog', async () => {
    const token = await create()
    const before = await getSettings(env, fallback)
    await env.UPTIMEFLARE_D1.prepare(
      "INSERT INTO notification_state VALUES('one','secret-notification','down',1,2,1)"
    ).run()
    const response = await manage(
      token.token,
      `groups/${before.groupIds.Alpha}/disable`,
      'POST',
      {}
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ updated: 2, paused: true, configRevision: 1 })
    const after = await getSettings(env, fallback)
    expect(after.monitors.map((monitor) => !!monitor.paused)).toEqual([true, true, false])
    expect(after.monitors[0].headers).toEqual(before.monitors[0].headers)
    expect(after.groupIds).toEqual(before.groupIds)
    expect((await markers()).map((row: any) => row.status)).toEqual(['paused', 'paused'])
    expect(await env.UPTIMEFLARE_D1.prepare('SELECT * FROM notification_state').first()).toBeNull()
    const batch = {
      version: 1,
      batch_id: 'a'.repeat(64),
      results: [
        {
          monitor_id: 'one',
          time: Math.floor(Date.now() / 1000) - 10,
          up: false,
          latency_ms: 0,
          stage: 'tcp',
          code: 'refused',
        },
      ],
    }
    const ingest = await handleProbeRequest(
      new Request('https://status.test/api/probes/ingest', {
        method: 'POST',
        headers: { Authorization: `Bearer ${PROBE}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(batch),
      }),
      env,
      after.monitors
    )
    expect(ingest.status).toBe(200)
    expect((await manage(token.token, 'monitors/one/enable', 'POST')).status).toBe(200)
    expect((await getSettings(env, fallback)).monitors.map((monitor) => !!monitor.paused)).toEqual([
      false,
      true,
      false,
    ])
    expect((await markers()).find((row: any) => row.monitor_id === 'one')).toMatchObject({
      status: 'awaiting',
    })
    expect(
      await env.UPTIMEFLARE_D1.prepare('SELECT COUNT(*) count FROM probe_samples').first()
    ).toEqual({ count: 1 })
  })
  it('preserves rename identity/current members while same-save recreation and retired IDs cannot revive authority', async () => {
    const token = await create()
    const old = (await getSettings(env, fallback)).groupIds.Alpha
    expect(
      (
        await save((settings) => ({
          ...settings,
          page: { ...settings.page, group: { Renamed: ['two'], Beta: ['three'] } },
          groupIds: { Renamed: old, Beta: settings.groupIds.Beta },
          groupRenames: { Alpha: 'Renamed' },
        }))
      ).status
    ).toBe(200)
    expect((await getSettings(env, fallback)).groupIds.Renamed).toBe(old)
    const inventory = (await (await manage(token.token, 'groups')).json()) as any
    expect(inventory.groups[0]).toMatchObject({
      id: old,
      name: 'Renamed',
      monitors: [{ id: 'two', name: 'Second' }],
    })
    expect((await manage(token.token, 'monitors/one/disable', 'POST')).status).toBe(403)
    expect(
      (await save((settings) => ({ ...settings, groupIds: { Beta: settings.groupIds.Beta } })))
        .status
    ).toBe(200)
    expect((await getSettings(env, fallback)).groupIds.Renamed).not.toBe(old)
    expect(((await (await manage(token.token, 'groups')).json()) as any).groups).toEqual([])
    expect((await manage(token.token, `groups/${old}/disable`, 'POST')).status).toBe(403)
    expect(
      (
        await save((settings) => ({
          ...settings,
          groupIds: { ...settings.groupIds, Renamed: old },
        }))
      ).status
    ).toBe(400)
    expect(
      (
        await save((settings) => {
          const { groupIds: _ids, ...legacy } = settings
          return legacy
        })
      ).status
    ).toBe(409)
  })
  it('revocation/expiry are immediate and concurrent creation respects 100 active credentials', async () => {
    const revoked = await create()
    expect((await admin(`tokens/${revoked.entry.id}`, 'DELETE')).status).toBe(200)
    expect((await manage(revoked.token)).status).toBe(401)
    expect((await manage(revoked.token, 'monitors/one/disable', 'POST')).status).toBe(401)
    const expired = await create()
    await env.UPTIMEFLARE_D1.prepare(
      'UPDATE management_tokens SET expires_at=unixepoch() WHERE id=?'
    )
      .bind(expired.entry.id)
      .run()
    expect((await manage(expired.token)).status).toBe(401)
    const settings = await getSettings(env, fallback)
    await env.UPTIMEFLARE_D1.batch(
      Array.from({ length: 99 }, (_, i) =>
        env.UPTIMEFLARE_D1.prepare(
          'INSERT INTO management_tokens VALUES(?,?,?,?,?,?,NULL,NULL)'
        ).bind(
          crypto.randomUUID(),
          'Seed',
          'seed-hash-' + i,
          JSON.stringify([settings.groupIds.Alpha]),
          3,
          Math.floor(Date.now() / 1000)
        )
      )
    )
    const attempts = await Promise.all([
      admin('tokens', 'POST', { name: 'A', groupIds: [settings.groupIds.Alpha] }),
      admin('tokens', 'POST', { name: 'B', groupIds: [settings.groupIds.Alpha] }),
    ])
    expect(attempts.map((response) => response.status).sort()).toEqual([201, 409])
    expect(
      await env.UPTIMEFLARE_D1.prepare(
        'SELECT COUNT(*) count FROM management_tokens WHERE revoked_at IS NULL AND (expires_at IS NULL OR expires_at>unixepoch())'
      ).first()
    ).toEqual({ count: 100 })
  })
  it('fences revocation/expiry exactly at CAS with no pause sideeffects', async () => {
    await env.UPTIMEFLARE_D1.batch([
      env.UPTIMEFLARE_D1.prepare(
        "INSERT INTO notification_state VALUES('one','notice','down',1,2,1)"
      ),
      env.UPTIMEFLARE_D1.prepare(
        "INSERT INTO notification_outbox VALUES('queued','one','notice',1,'{}',1,1,0,9999999999,'existing-lease')"
      ),
      env.UPTIMEFLARE_D1.prepare(
        "INSERT INTO notification_observations VALUES('one','notice','down',1,2,2,'existing-reason',1,1)"
      ),
      env.UPTIMEFLARE_D1.prepare(
        "INSERT INTO monitor_schedule VALUES('cloudflare','one','existing-config',1,1,9999999999,'existing-lease')"
      ),
    ])
    const snapshot = async () =>
      Promise.all(
        [
          'notification_state',
          'notification_outbox',
          'notification_deliveries',
          'notification_observations',
          'monitor_schedule',
        ].map((table) =>
          env.UPTIMEFLARE_D1.prepare(`SELECT * FROM ${table}`)
            .all()
            .then((result) => result.results)
        )
      )
    const beforeEffects = await snapshot()
    for (const field of ['revoked_at', 'expires_at']) {
      const token = await create()
      const before = (await getSettings(env, fallback)).revision
      const racing = interleave(async () => {
        await env.UPTIMEFLARE_D1.prepare(
          `UPDATE management_tokens SET ${field}=unixepoch() WHERE id=?`
        )
          .bind(token.entry.id)
          .run()
      })
      expect(
        (await manage(token.token, 'monitors/one/disable', 'POST', undefined, racing)).status
      ).toBe(401)
      expect((await getSettings(env, fallback)).revision).toBe(before)
      expect(await snapshot()).toEqual(beforeEffects)
      expect((await getSettings(env, fallback)).monitors.some((monitor) => monitor.paused)).toBe(
        false
      )
    }
  })
  it('fences concurrent admin membership changes and preserves the winning config', async () => {
    const token = await create()
    const racing = interleave(async () => {
      expect(
        (
          await save((settings) => ({
            ...settings,
            page: { ...settings.page, group: { Alpha: ['two'], Beta: ['one', 'three'] } },
          }))
        ).status
      ).toBe(200)
    })
    expect(
      (await manage(token.token, 'monitors/one/disable', 'POST', undefined, racing)).status
    ).toBe(409)
    expect((await getSettings(env, fallback)).page!.group!.Beta).toEqual(['one', 'three'])
    expect(await markers()).toEqual([])
    expect((await manage(token.token, 'monitors/one/disable', 'POST')).status).toBe(403)
  })
  it('checks live membership even for out-of-band SQL edits that omit the config revision', async () => {
    const token = await create()
    const racing = interleave(async () => {
      await env.UPTIMEFLARE_D1.prepare(
        "UPDATE admin_config SET value=json_set(value,'$.page.group.Alpha',json('[\"two\"]')) WHERE id=1"
      ).run()
    })
    expect(
      (await manage(token.token, 'monitors/one/disable', 'POST', undefined, racing)).status
    ).toBe(409)
    expect(await markers()).toEqual([])
    expect((await getSettings(env, fallback)).monitors[0].paused).toBeUndefined()
  })
  it('fences removed permission/grants and equal-revision racing controls without transition sideeffects', async () => {
    for (const mutation of ['permissions=1', "group_ids='[]'"]) {
      const token = await create()
      const revision = (await getSettings(env, fallback)).revision
      const racing = interleave(async () => {
        await env.UPTIMEFLARE_D1.prepare(`UPDATE management_tokens SET ${mutation} WHERE id=?`)
          .bind(token.entry.id)
          .run()
      })
      expect(
        (await manage(token.token, 'monitors/one/disable', 'POST', undefined, racing)).status
      ).toBe(409)
      expect((await getSettings(env, fallback)).revision).toBe(revision)
      expect(await markers()).toEqual([])
    }
    const token = await create()
    const racing = interleave(async () => {
      expect((await manage(token.token, 'monitors/two/disable', 'POST')).status).toBe(200)
    })
    expect(
      (await manage(token.token, 'monitors/one/disable', 'POST', undefined, racing)).status
    ).toBe(409)
    expect((await getSettings(env, fallback)).monitors.map((monitor) => !!monitor.paused)).toEqual([
      false,
      true,
      false,
    ])
    expect((await markers()).map((row: any) => row.monitor_id)).toEqual(['two'])
  })
  it('rechecks revocation after reading status before returning any data', async () => {
    const token = await create()
    let intercepted = false
    const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, property) {
          if (property === 'bind') return (...values: any[]) => wrap(target.bind(...values))
          if (property === 'first')
            return async (...args: any[]) => {
              if (!intercepted) {
                intercepted = true
                await env.UPTIMEFLARE_D1.prepare(
                  'UPDATE management_tokens SET revoked_at=unixepoch() WHERE id=?'
                )
                  .bind(token.entry.id)
                  .run()
              }
              return target.first(...args)
            }
          const value = Reflect.get(target, property)
          return typeof value === 'function' ? value.bind(target) : value
        },
      })
    const racing = {
      ...env,
      UPTIMEFLARE_D1: new Proxy(env.UPTIMEFLARE_D1, {
        get(target, property) {
          if (property === 'prepare')
            return (sql: string) =>
              sql.includes('SELECT 1 FROM management_tokens t JOIN admin_config')
                ? wrap(target.prepare(sql))
                : target.prepare(sql)
          const value = Reflect.get(target, property)
          return typeof value === 'function' ? value.bind(target) : value
        },
      }),
    }
    const response = await manage(token.token, 'status', 'GET', undefined, racing)
    expect(response.status).toBe(401)
    expect(await response.json()).not.toHaveProperty('monitors')
    expect(intercepted).toBe(true)
  })
  it('bounds retained revoked metadata and applies the token migration idempotently', async () => {
    const id = (await getSettings(env, fallback)).groupIds.Alpha
    await env.UPTIMEFLARE_D1.prepare(
      `WITH RECURSIVE n(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM n WHERE i<999)
      INSERT INTO management_tokens SELECT 'retained-'||i,'Retained','retained-hash-'||i,?,3,unixepoch(),NULL,unixepoch() FROM n`
    )
      .bind(JSON.stringify([id]))
      .run()
    expect((await create()).entry.revokedAt).toBeNull()
    expect(
      await env.UPTIMEFLARE_D1.prepare('SELECT COUNT(*) count FROM management_tokens').first()
    ).toEqual({ count: 1000 })
    for (let iteration = 0; iteration < 2; iteration++)
      for (const sql of readFileSync(
        new URL('../../migrations/0008_management_tokens.sql', import.meta.url),
        'utf8'
      )
        .split(';')
        .filter((value) => value.trim()))
        await env.UPTIMEFLARE_D1.prepare(sql).run()
    expect(
      await env.UPTIMEFLARE_D1.prepare('SELECT COUNT(*) count FROM management_tokens').first()
    ).toEqual({ count: 1000 })
  })
  it('uses fresh native state and real zero latency without exposing native diagnostics', async () => {
    const now = Math.floor(Date.now() / 1000)
    await env.UPTIMEFLARE_D1.prepare(
      "UPDATE admin_config SET value=json_set(value,'$.monitors[0].probes',json('[]'))"
    ).run()
    const token = await create()
    const state = new CompactedMonitorStateWrapper(null)
    state.appendLatency('one', { time: now, ping: 0, loc: 'private-location' })
    state.appendIncident('one', { start: [now - 10], end: now - 5, error: ['dummy'] })
    await setToStore(env, 'state', state.getCompactedStateStr())
    const data = (await (await manage(token.token, 'monitors/one/status')).json()) as any
    expect(data.monitors[0]).toMatchObject({ status: 'up', latencyMs: 0, latest: now })
    expect(JSON.stringify(data)).not.toMatch(/private|error|loc/)
  })
})
