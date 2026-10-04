import { beforeAll, beforeEach, afterAll, expect, it, vi } from 'vitest'
import { Miniflare } from 'miniflare'
import { readFileSync } from 'node:fs'
import type { WorkerConfig } from '../../types/config'
import type { PublicDashboardSnapshot } from '../../types/public-dashboard'
import {
  buildPublicDashboard,
  getPublicDashboard,
  sanitizePublicSnapshot,
  publishPublicConfiguration,
  publishPublicDashboard,
  PUBLIC_CONFIGURATION_KEY,
  PUBLIC_DASHBOARD_KEY,
  type PublicDashboardEnv,
} from '../src/public-dashboard'
import { saveConfiguration } from '../src/configuration-write'
import { CompactedMonitorStateWrapper } from '../src/store'

const NOW = Math.floor(Date.now() / 1000)
let mf: Miniflare, env: PublicDashboardEnv
const target = {
  id: 'host',
  name: 'Host',
  method: 'GET',
  target: 'https://PRIVATE-target',
  probes: ['a'],
  headers: { Authorization: 'PRIVATE-header' },
  checkProxy: 'https://PRIVATE-proxy',
  notificationTemplateId: 'PRIVATE-notification',
}
const config: WorkerConfig & { revision: number } = {
  revision: 14,
  monitors: [target, { ...target, id: 'closed', paused: true }],
  page: { title: 'Status', group: { Home: ['host'], Closed: ['closed'] } },
  probes: [{ id: 'a', name: 'Probe A' }],
}
const summaries = {
  host: {
    monitorId: 'host',
    status: 'up',
    up: 1,
    down: 0,
    unknown: 0,
    total: 1,
    latest: NOW,
    probes: [
      {
        id: 'a',
        name: 'Probe A',
        status: 'up',
        stale: false,
        latest: NOW,
        latencyMs: 12,
        message: 'PRIVATE-error',
        checks: 100,
        failures: 0,
        uptimePercent: 100,
        history: [{ time: NOW }],
      },
    ],
    dailyHistory: [{ time: NOW }],
    uptimePercent: 100,
  },
} as any
beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: '2025-04-02',
    d1Databases: ['UPTIMEFLARE_D1'],
    kvNamespaces: ['UPTIMEFLARE_PUBLIC_KV'],
  })
  env = {
    UPTIMEFLARE_D1: (await mf.getD1Database('UPTIMEFLARE_D1')) as unknown as D1Database,
    UPTIMEFLARE_PUBLIC_KV: (await mf.getKVNamespace(
      'UPTIMEFLARE_PUBLIC_KV'
    )) as unknown as KVNamespace,
  }
  for (const sql of readFileSync(new URL('../../init.sql', import.meta.url), 'utf8')
    .split(';')
    .filter((value) => value.trim()))
    await env.UPTIMEFLARE_D1.prepare(sql).run()
}, 30000)
beforeEach(async () => {
  vi.unstubAllGlobals()
  await env.UPTIMEFLARE_PUBLIC_KV!.delete(PUBLIC_DASHBOARD_KEY)
  await env.UPTIMEFLARE_PUBLIC_KV!.delete(PUBLIC_CONFIGURATION_KEY)
  await env.UPTIMEFLARE_D1.batch(
    ['admin_config', 'uptimeflare', 'probe_latest', 'probe_totals'].map((table) =>
      env.UPTIMEFLARE_D1.prepare(`DELETE FROM ${table}`)
    )
  )
})
afterAll(async () => {
  vi.unstubAllGlobals()
  await mf?.dispose()
})
async function seed(
  snapshot: PublicDashboardSnapshot = buildPublicDashboard(config, NOW, true, summaries)
) {
  await env.UPTIMEFLARE_PUBLIC_KV!.put(PUBLIC_DASHBOARD_KEY, JSON.stringify(snapshot))
}
function blockedD1() {
  return {
    ...env,
    UPTIMEFLARE_D1: {
      prepare() {
        throw new Error('D1 daily row read limit exceeded')
      },
      batch() {
        throw new Error('D1 forbidden')
      },
    } as unknown as D1Database,
  }
}
it('serves the public snapshot without any D1 read, strips secrets/history, and retains paused counts', async () => {
  await seed()
  const dashboard = await getPublicDashboard(blockedD1(), config, NOW)
  expect(dashboard.source).toBe('kv')
  expect(dashboard.stale).toBe(false)
  expect(dashboard.probeSummaries.host.status).toBe('up')
  expect(dashboard.monitors.filter((m) => m.paused)).toHaveLength(1)
  expect(dashboard.probeSummaries.closed.status).toBe('paused')
  expect(dashboard.probeSummaries.host.historyLoaded).toBe(false)
  expect(dashboard.probeSummaries.host.probes[0].history).toEqual([])
  expect(JSON.stringify(dashboard)).not.toContain('PRIVATE')
  expect(dashboard.monitors[0].target).toBe('')
})
it('allows a last-known snapshot during D1 exhaustion but never presents stale successes as green', async () => {
  await seed()
  const dashboard = await getPublicDashboard(blockedD1(), config, NOW + 181)
  expect(dashboard.stale).toBe(true)
  expect(dashboard.snapshotAt).toBe(NOW)
  expect(dashboard.probeSummaries.host.status).toBe('unknown')
  expect(dashboard.probeSummaries.host.probes[0].latest).toBe(NOW)
  expect(dashboard.probeSummaries.host.probes[0].status).toBe('unknown')
  expect(dashboard.compactedStateStr).toBeNull()
})
it('supports metadata-only recovery snapshots with every active target unknown and closed targets preserved', async () => {
  await seed(buildPublicDashboard(config, NOW))
  const dashboard = await getPublicDashboard(blockedD1(), config, NOW)
  expect(dashboard.snapshotIncomplete).toBe(true)
  expect(dashboard.stale).toBe(true)
  expect(dashboard.probeSummaries.host.status).toBe('unknown')
  expect(dashboard.probeSummaries.host.total).toBe(1)
  expect(dashboard.probeSummaries.closed.status).toBe('paused')
})
it('uses newer configuration override even after an old Cron snapshot finishes, never reviving paused checks', async () => {
  const newer = {
    ...config,
    revision: 15,
    monitors: config.monitors.map((m) => ({ ...m, paused: true })),
  }
  await env.UPTIMEFLARE_PUBLIC_KV!.put(
    PUBLIC_CONFIGURATION_KEY,
    JSON.stringify(buildPublicDashboard(newer, NOW))
  )
  await seed()
  const dashboard = await getPublicDashboard(blockedD1(), config, NOW)
  expect(dashboard.configRevision).toBe(15)
  expect(dashboard.monitors.every((m) => m.paused)).toBe(true)
  expect(dashboard.probeSummaries.host.status).toBe('paused')
  expect(dashboard.stale).toBe(true)
})
it('uses the complete snapshot after the Cron catches up to the same configuration revision', async () => {
  await env.UPTIMEFLARE_PUBLIC_KV!.put(
    PUBLIC_CONFIGURATION_KEY,
    JSON.stringify(buildPublicDashboard(config, NOW))
  )
  await seed()
  expect((await getPublicDashboard(blockedD1(), config, NOW)).stale).toBe(false)
})
it('minute consumption cache avoids repeating KV reads but freshness is recalculated every request', async () => {
  await seed()
  let stored: Response | undefined,
    reads = 0
  vi.stubGlobal('caches', {
    default: {
      match: async () => stored?.clone(),
      put: async (_key: string, response: Response) => {
        stored = response.clone()
      },
    },
  })
  const kv = new Proxy(env.UPTIMEFLARE_PUBLIC_KV!, {
    get(target, property) {
      if (property === 'get')
        return async (...args: any[]) => {
          reads++
          return (target.get as any)(...args)
        }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const scoped = { ...blockedD1(), UPTIMEFLARE_PUBLIC_KV: kv }
  expect((await getPublicDashboard(scoped, config, NOW)).stale).toBe(false)
  expect((await getPublicDashboard(scoped, config, NOW + 181)).stale).toBe(true)
  expect(reads).toBe(2)
  expect(stored!.headers.get('Cache-Control')).toBe('public, max-age=60')
})
it('does not fabricate static fallback monitors or query D1 if a configured KV snapshot is missing/corrupt', async () => {
  await expect(getPublicDashboard(blockedD1(), config, NOW)).rejects.toThrow(
    'snapshot is unavailable'
  )
  await env.UPTIMEFLARE_PUBLIC_KV!.put(PUBLIC_DASHBOARD_KEY, '{invalid')
  await expect(getPublicDashboard(blockedD1(), config, NOW)).rejects.toThrow()
})
it('strict allowlisting also applies to manually seeded snapshots and maintenance scoping', () => {
  const snapshot = sanitizePublicSnapshot({
    ...buildPublicDashboard(config, NOW, true, summaries),
    token: 'PRIVATE-token',
    _groupIds: { Home: 'PRIVATE-group-id' },
    page: { ...config.page, secret: 'PRIVATE-page' },
    maintenances: [
      {
        body: 'Removed target maintenance',
        start: NOW,
        monitors: ['deleted-target'],
        secret: 'PRIVATE-maintenance',
      },
    ],
    probeSummaries: { ...summaries, retired: { message: 'PRIVATE-retired' } },
  })
  expect(JSON.stringify(snapshot)).not.toContain('PRIVATE')
  expect(snapshot.maintenances).toEqual([])
  expect(Object.keys(snapshot.probeSummaries)).toEqual(['host', 'closed'])
})
it('configuration publication skips an old saved revision and does not overwrite a newer public override', async () => {
  await env.UPTIMEFLARE_D1.prepare('INSERT INTO admin_config VALUES(1,15,?,?)')
    .bind(JSON.stringify(config), NOW)
    .run()
  await publishPublicConfiguration(env, config, 14)
  expect(await env.UPTIMEFLARE_PUBLIC_KV!.get(PUBLIC_CONFIGURATION_KEY)).toBeNull()
  await publishPublicConfiguration(env, config, 15)
  expect(
    JSON.parse((await env.UPTIMEFLARE_PUBLIC_KV!.get(PUBLIC_CONFIGURATION_KEY))!).configRevision
  ).toBe(15)
  await publishPublicConfiguration(env, config, 14)
  expect(
    JSON.parse((await env.UPTIMEFLARE_PUBLIC_KV!.get(PUBLIC_CONFIGURATION_KEY))!).configRevision
  ).toBe(15)
})
it('only a successful configuration CAS publishes a safe override; conflicts publish nothing', async () => {
  await env.UPTIMEFLARE_D1.prepare('INSERT INTO admin_config VALUES(1,14,?,?)')
    .bind(JSON.stringify(config), NOW)
    .run()
  const changed = { ...config, monitors: config.monitors.map((m) => ({ ...m, paused: true })) }
  expect(await saveConfiguration(env, changed, 14, config.monitors)).toBe(true)
  const serialized = (await env.UPTIMEFLARE_PUBLIC_KV!.get(PUBLIC_CONFIGURATION_KEY))!
  expect(JSON.parse(serialized).configRevision).toBe(15)
  expect(serialized).not.toContain('PRIVATE')
  expect(await saveConfiguration(env, config, 14, changed.monitors)).toBe(false)
  expect(await env.UPTIMEFLARE_PUBLIC_KV!.get(PUBLIC_CONFIGURATION_KEY)).toBe(serialized)
})
it('publishes only even-minute Cron slots and idempotently rejects duplicate delivery', async () => {
  const even = Math.floor(NOW / 120) * 120
  expect(await publishPublicDashboard(env, config, even + 60)).toBe(false)
  expect(await publishPublicDashboard(env, config, even)).toBe(true)
  expect(await publishPublicDashboard(env, config, even)).toBe(false)
  const snapshot = JSON.parse((await env.UPTIMEFLARE_PUBLIC_KV!.get(PUBLIC_DASHBOARD_KEY))!)
  expect(snapshot.complete).toBe(true)
  expect(snapshot.monitors).toHaveLength(2)
})
it('a failed Cron D1 refresh leaves the previous persisted snapshot intact', async () => {
  await seed()
  const previous = await env.UPTIMEFLARE_PUBLIC_KV!.get(PUBLIC_DASHBOARD_KEY)
  await expect(
    publishPublicDashboard(blockedD1(), config, Math.floor(NOW / 120) * 120)
  ).rejects.toThrow('D1 daily')
  expect(await env.UPTIMEFLARE_PUBLIC_KV!.get(PUBLIC_DASHBOARD_KEY)).toBe(previous)
})
it('projects native latest state only and removes error details, deleted targets, and stale success state', async () => {
  const nativeConfig = { ...config, monitors: [{ ...target, probes: undefined }] }
  const state = JSON.stringify({
    lastUpdate: NOW,
    overallUp: 4,
    overallDown: 1,
    incident: {
      host: { start: [[NOW - 1]], end: [NOW], error: [['[tcp/refused] PRIVATE-target-error']] },
      retired: { secret: 'PRIVATE-retired' },
    },
    latency: {
      host: { time: '1234567812345678', ping: '000c000d', loc: { v: ['SIN'], c: [2] } },
      retired: { secret: 'PRIVATE-retired' },
    },
  })
  const snapshot = buildPublicDashboard(nativeConfig, NOW, true, {}, state)
  expect(snapshot.compactedStateStr).not.toContain('PRIVATE')
  expect(JSON.parse(snapshot.compactedStateStr!).latency.host.time).toBe('12345678')
  expect(JSON.parse(snapshot.compactedStateStr!).incident.host.error).toEqual([
    ['[tcp/refused] Status observation'],
  ])
  await seed(snapshot)
  expect(
    (await getPublicDashboard(blockedD1(), nativeConfig, NOW + 181)).compactedStateStr
  ).toBeNull()
})
it('uses the static public metadata recovery only for an explicit D1 read quota failure, with accurate closed targets', async () => {
  let assetReads = 0
  const fallback = {
    ...blockedD1(),
    UPTIMEFLARE_PUBLIC_KV: undefined,
    ASSETS: {
      fetch: async (request: Request) => {
        assetReads++
        expect(new URL(request.url).pathname).toBe('/public-dashboard-recovery.json')
        return new Response(JSON.stringify(buildPublicDashboard(config, NOW)))
      },
    } as unknown as Fetcher,
  }
  const dashboard = await getPublicDashboard(fallback, config, NOW)
  expect(dashboard.source).toBe('recovery')
  expect(dashboard.stale).toBe(true)
  expect(dashboard.snapshotIncomplete).toBe(true)
  expect(dashboard.configRevision).toBe(14)
  expect(dashboard.probeSummaries.host.status).toBe('unknown')
  expect(dashboard.probeSummaries.host.probes[0].name).toBe('Probe A')
  expect(dashboard.monitors.filter((m) => m.paused)).toHaveLength(1)
  expect(assetReads).toBe(1)
  expect(JSON.stringify(dashboard)).not.toContain('PRIVATE')
})
it('never hides a SQL/configuration failure with metadata recovery or fetches recovery when a KV binding exists', async () => {
  let assetReads = 0
  const assets = {
    fetch: async () => {
      assetReads++
      return new Response('{}')
    },
  } as unknown as Fetcher
  const broken = {
    ...env,
    UPTIMEFLARE_PUBLIC_KV: undefined,
    ASSETS: assets,
    UPTIMEFLARE_D1: {
      prepare() {
        throw new Error('SQL table missing')
      },
    } as unknown as D1Database,
  }
  await expect(getPublicDashboard(broken, config, NOW)).rejects.toThrow('SQL table missing')
  await expect(getPublicDashboard({ ...blockedD1(), ASSETS: assets }, config, NOW)).rejects.toThrow(
    'snapshot is unavailable'
  )
  expect(assetReads).toBe(0)
})
it('rejects complete recovery state instead of pretending manually seeded results are current', async () => {
  const fallback = {
    ...blockedD1(),
    UPTIMEFLARE_PUBLIC_KV: undefined,
    ASSETS: {
      fetch: async () =>
        new Response(JSON.stringify(buildPublicDashboard(config, NOW, true, summaries))),
    } as unknown as Fetcher,
  }
  await expect(getPublicDashboard(fallback, config, NOW)).rejects.toThrow('metadata only')
})
it('caches the static metadata for a minute and bounds recovery asset size', async () => {
  let stored: Response | undefined,
    reads = 0
  vi.stubGlobal('caches', {
    default: {
      match: async () => stored?.clone(),
      put: async (_url: string, response: Response) => {
        stored = response.clone()
      },
    },
  })
  const fallback = {
    ...blockedD1(),
    UPTIMEFLARE_PUBLIC_KV: undefined,
    ASSETS: {
      fetch: async () => {
        reads++
        return new Response(JSON.stringify(buildPublicDashboard(config, NOW)))
      },
    } as unknown as Fetcher,
  }
  await getPublicDashboard(fallback, config, NOW)
  await getPublicDashboard(fallback, config, NOW + 1)
  expect(reads).toBe(1)
  expect(stored!.headers.get('Cache-Control')).toBe('public, max-age=60')
  vi.unstubAllGlobals()
  fallback.ASSETS = {
    fetch: async () => new Response('x'.repeat(256 * 1024 + 1)),
  } as unknown as Fetcher
  await expect(getPublicDashboard(fallback, config, NOW)).rejects.toThrow('exceeds limit')
})
it('does not retry exhausted D1 on every request while the minute-long recovery cache remains valid', async () => {
  let stored: Response | undefined,
    d1Reads = 0
  vi.stubGlobal('caches', {
    default: {
      match: async () => stored?.clone(),
      put: async (_url: string, response: Response) => {
        stored = response.clone()
      },
    },
  })
  const fallback = {
    ...env,
    UPTIMEFLARE_PUBLIC_KV: undefined,
    UPTIMEFLARE_D1: {
      prepare() {
        d1Reads++
        throw new Error("D1_ERROR: Your account has exceeded D1's free tier daily row read limit")
      },
    } as unknown as D1Database,
    ASSETS: {
      fetch: async () => new Response(JSON.stringify(buildPublicDashboard(config, NOW))),
    } as unknown as Fetcher,
  }
  expect((await getPublicDashboard(fallback, config, NOW)).source).toBe('recovery')
  expect((await getPublicDashboard(fallback, config, NOW + 1)).source).toBe('recovery')
  expect(d1Reads).toBe(1)
  stored = undefined
  await getPublicDashboard(fallback, config, NOW + 61)
  expect(d1Reads).toBe(2)
})
it('serializes configuration publishers across distinct isolates, then catches up skipped changes via Cron', async () => {
  await env.UPTIMEFLARE_D1.prepare('INSERT INTO admin_config VALUES(1,15,?,?)')
    .bind(JSON.stringify(config), NOW)
    .run()
  let ready!: () => void, release!: () => void
  const started = new Promise<void>((resolve) => {
    ready = resolve
  })
  const held = new Promise<void>((resolve) => {
    release = resolve
  })
  let blocked = true
  const kv = new Proxy(env.UPTIMEFLARE_PUBLIC_KV!, {
    get(target, property) {
      if (property === 'put')
        return async (key: string, value: string) => {
          if (key === PUBLIC_CONFIGURATION_KEY && blocked) {
            blocked = false
            ready()
            await held
          }
          return target.put(key, value)
        }
      const value = Reflect.get(target, property)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const scoped = { ...env, UPTIMEFLARE_PUBLIC_KV: kv }
  const first = publishPublicConfiguration(scoped, config, 15)
  await started
  await env.UPTIMEFLARE_D1.prepare('UPDATE admin_config SET revision=16 WHERE id=1').run()
  const latest = { ...config, monitors: config.monitors.map((m) => ({ ...m, paused: true })) }
  // A different binding object simulates another Worker isolate, defeating WeakMap locks.
  const second = publishPublicConfiguration(
    { ...env, UPTIMEFLARE_PUBLIC_KV: new Proxy(env.UPTIMEFLARE_PUBLIC_KV!, {}) },
    latest,
    16
  )
  await second
  expect(await env.UPTIMEFLARE_PUBLIC_KV!.get(PUBLIC_CONFIGURATION_KEY)).toBeNull()
  release()
  await Promise.all([first, second])
  expect(
    JSON.parse((await env.UPTIMEFLARE_PUBLIC_KV!.get(PUBLIC_CONFIGURATION_KEY))!).configRevision
  ).toBe(15)
  // The skipped configuration is not lost: the next normal producer uses the current revision.
  await publishPublicDashboard(env, { ...latest, revision: 16 }, Math.floor(NOW / 120) * 120)
  const dashboard = await getPublicDashboard(scoped, config, NOW)
  expect(dashboard.configRevision).toBe(16)
  expect(dashboard.monitors.every((m) => m.paused)).toBe(true)
})
it('a crashed immediate publisher cannot block current Cron snapshots or cause an indefinite metadata rollback', async () => {
  await env.UPTIMEFLARE_D1.prepare(
    "INSERT INTO uptimeflare VALUES('public_config_publisher','crashed-owner')"
  ).run()
  await env.UPTIMEFLARE_D1.prepare('INSERT INTO admin_config VALUES(1,16,?,?)')
    .bind(JSON.stringify(config), NOW)
    .run()
  const latest = {
    ...config,
    revision: 16,
    monitors: config.monitors.map((m) => ({ ...m, paused: true })),
  }
  await publishPublicConfiguration(env, latest, 16)
  expect(await env.UPTIMEFLARE_PUBLIC_KV!.get(PUBLIC_CONFIGURATION_KEY)).toBeNull()
  await publishPublicDashboard(env, latest, Math.floor(NOW / 120) * 120)
  const dashboard = await getPublicDashboard(blockedD1(), config, NOW)
  expect(dashboard.configRevision).toBe(16)
  expect(dashboard.monitors.every((m) => m.paused)).toBe(true)
})
it('preserves empty native samples and a genuine zero millisecond measurement without mismatched location counts', () => {
  const native = { ...config, monitors: [{ ...target, probes: undefined }] }
  const empty = buildPublicDashboard(
    native,
    NOW,
    true,
    {},
    JSON.stringify({
      lastUpdate: NOW,
      incident: {},
      latency: { host: { time: '', ping: '', loc: { v: [], c: [] } } },
    })
  )
  expect(JSON.parse(empty.compactedStateStr!).latency.host.loc).toEqual({ v: [], c: [] })
  expect(
    new CompactedMonitorStateWrapper(empty.compactedStateStr).uncompact().latency.host
  ).toEqual([])
  const zero = buildPublicDashboard(
    native,
    NOW,
    true,
    {},
    JSON.stringify({
      lastUpdate: NOW,
      incident: {},
      latency: { host: { time: '01000000', ping: '0000', loc: { v: ['SIN'], c: [1] } } },
    })
  )
  expect(
    new CompactedMonitorStateWrapper(zero.compactedStateStr).uncompact().latency.host[0].ping
  ).toBe(0)
})
it('degrades oversized public metadata without blocking state, releases publisher locks, and retains fitting footers', async () => {
  await seed()
  const large = {
    ...config,
    revision: 15,
    monitors: Array.from({ length: 100 }, (_, index) => ({
      ...target,
      id: `host-${index}`,
      tooltip: 'x'.repeat(4096),
    })),
  }
  await publishPublicDashboard(env, large, Math.floor(NOW / 120) * 120)
  const value = (await env.UPTIMEFLARE_PUBLIC_KV!.get(PUBLIC_DASHBOARD_KEY))!
  expect(new TextEncoder().encode(value).byteLength).toBeLessThanOrEqual(256 * 1024)
  expect(sanitizePublicSnapshot(JSON.parse(value)).monitors).toHaveLength(100)
  await env.UPTIMEFLARE_D1.prepare('INSERT INTO admin_config VALUES(1,15,?,?)')
    .bind(JSON.stringify(large), NOW)
    .run()
  await publishPublicConfiguration(env, large, 15)
  expect(await env.UPTIMEFLARE_PUBLIC_KV!.get(PUBLIC_CONFIGURATION_KEY)).not.toBeNull()
  expect(
    await env.UPTIMEFLARE_D1.prepare(
      "SELECT value FROM uptimeflare WHERE key='public_config_publisher'"
    ).first()
  ).toBeNull()
  expect(
    buildPublicDashboard({ ...config, page: { customFooter: 'x'.repeat(16384) } }, NOW).page
      .customFooter
  ).toHaveLength(16384)
})

it('keeps500 targets and1650 multi-probe assignments within the UTF8 public budget without losing lifecycle', async () => {
  await seed()
  const large = {
    ...config,
    revision: 99,
    monitors: Array.from({ length: 500 }, (_, i) => ({
      ...target,
      id: 'x'.repeat(120) + i,
      name: '中文'.repeat(128),
      tooltip: '汉'.repeat(4096),
      probes: i < 150 ? ['a', 'b', 'c', 'cloudflare'] : ['a', 'b', 'c'],
      paused: i === 0,
    })),
    page: { title: 'Status', group: {} },
  }
  await publishPublicDashboard(env, large, Math.floor(NOW / 120) * 120 + 120)
  const raw = (await env.UPTIMEFLARE_PUBLIC_KV!.get(PUBLIC_DASHBOARD_KEY))!
  expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(256 * 1024)
  const snapshot = sanitizePublicSnapshot(JSON.parse(raw))
  expect(snapshot.monitors).toHaveLength(500)
  expect(snapshot.monitors[0].paused).toBe(true)
  expect(snapshot.monitors.reduce((n, m) => n + (m.probes?.length ?? 0), 0)).toBe(1650)
})
