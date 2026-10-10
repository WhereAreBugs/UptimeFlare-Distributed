import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import {
  publicationState,
  reservePublication,
  finishPublication,
  PUBLICATION_LIMITS,
  publicationInterval,
} from '../src/public-publication'
import { PublicChanges } from '../src/public-change'
import type { ProbeEnv } from '../src/probes'

let mf: Miniflare, env: ProbeEnv
beforeAll(async () => {
  mf = new Miniflare({
    modules: true,
    script: 'export default {}',
    compatibilityDate: '2025-04-02',
    d1Databases: ['DB'],
  })
  env = { UPTIMEFLARE_D1: (await mf.getD1Database('DB')) as unknown as D1Database }
  await env.UPTIMEFLARE_D1.prepare(
    'CREATE TABLE uptimeflare(key TEXT PRIMARY KEY,value TEXT)'
  ).run()
}, 30000)
beforeEach(() => env.UPTIMEFLARE_D1.prepare('DELETE FROM uptimeflare').run())
afterAll(() => mf.dispose())

it('bounds all public KV reservations, including failed writes, and resets only the counters at UTC midnight', async () => {
  const base = 20000 * 86400
  let now = base
  for (const kind of ['scheduled', 'event', 'configuration'] as const) {
    for (let i = 0; i < PUBLICATION_LIMITS[kind]; i++) {
      now += 60
      expect(await reservePublication(env, kind, now, now)).toBeTruthy()
    }
    now += 60
    expect(await reservePublication(env, kind, now, now)).toBeNull()
  }
  expect(await publicationState(env)).toMatchObject({
    scheduled: 720,
    event: 144,
    configuration: 100,
  })
  const next = base + 86400
  const owner = await reservePublication(env, 'event', next, next)
  expect(owner).toBeTruthy()
  await finishPublication(env, owner!, 'sample-fingerprint', next)
  expect(await publicationState(env)).toMatchObject({
    event: 1,
    scheduled: 0,
    configuration: 0,
    digest: 'sample-fingerprint',
    publishedAt: next,
  })
}, 30000)

it('serializes concurrent measurement reservations, rejects old Cron slots, and preserves pending measurement ownership through configuration saves', async () => {
  const now = 20000 * 86400
  const attempts = await Promise.all(
    Array.from({ length: 12 }, () => reservePublication(env, 'scheduled', now, now))
  )
  const owner = attempts.find(Boolean)!
  expect(attempts.filter(Boolean)).toHaveLength(1)
  expect(await reservePublication(env, 'event', now + 1, now + 1)).toBeNull()
  expect(await reservePublication(env, 'configuration', 0, now + 1)).toBeTruthy()
  await finishPublication(env, owner, 'original', now)
  await finishPublication(env, 'wrong-owner', 'regressed', now + 1)
  expect(await publicationState(env)).toMatchObject({
    digest: 'original',
    scheduled: 1,
    configuration: 1,
  })
  expect(await reservePublication(env, 'scheduled', now, now + 300)).toBeNull()
  expect(await reservePublication(env, 'scheduled', now + 300, now + 300)).toBeTruthy()
})

it('upgrades the existing numeric slot in place without schema migration', async () => {
  await env.UPTIMEFLARE_D1.prepare(
    "INSERT INTO uptimeflare VALUES('public_snapshot_slot','1800000000')"
  ).run()
  expect(await publicationState(env)).toEqual({})
  expect(await reservePublication(env, 'scheduled', 1800000300, 1800000300)).toBeTruthy()
})
it('preserves short-interval freshness without letting paused fast targets increase publication frequency', () => {
  const fast = {
    id: 'fast',
    name: 'Fast',
    method: 'GET',
    target: 'https://fixture.test',
    intervalSeconds: 60,
  }
  expect(publicationInterval({ monitors: [fast] })).toBe(120)
  expect(publicationInterval({ monitors: [{ ...fast, intervalSeconds: 300 }] })).toBe(300)
  expect(publicationInterval({ monitors: [{ ...fast, paused: true }] })).toBe(300)
})

it('hints only meaningful recent transitions, ignoring repeated failures, old backlog and latency-only changes', () => {
  const hints = new PublicChanges(),
    now = 1800000000
  const sample = { monitor_id: 'one', time: now - 300, up: true, latency_ms: 10 }
  expect(hints.observe('a', [sample], now)).toBe(false)
  expect(hints.observe('a', [{ ...sample, time: now - 240, latency_ms: 15 }], now)).toBe(false)
  const failure = { ...sample, time: now - 180, up: false, stage: 'tcp' as const, code: 'refused' }
  expect(hints.observe('a', [failure], now)).toBe(true)
  expect(hints.observe('a', [{ ...failure, time: now - 120 }], now)).toBe(false)
  expect(hints.observe('a', [{ ...failure, time: now - 2400, code: 'timeout' }], now)).toBe(false)
  expect(hints.observe('a', [{ ...sample, time: now - 60 }], now)).toBe(true)
  expect(hints.observe('b', [failure], now)).toBe(true)
})
