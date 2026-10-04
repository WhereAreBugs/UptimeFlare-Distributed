import { publicNativeV2 } from '../src/storage-v2'
import { beforeAll, beforeEach, afterAll, expect, it } from 'vitest'
import { Miniflare } from 'miniflare'
import { readFileSync } from 'node:fs'
import { persistBatch, getProbeSummaries, getProbeIncidents } from '../src/probes'
import { runNativeMonitors } from '../src/native-monitor'
import { getPublicNativeState } from '../src/store'
import { getNativeIncidents } from '../src/incident-history'
import { beginCommit, releaseCommit } from '../src/commit'
import { splitResultBlocks, MAX_BLOCK_BYTES } from '../src/packed-probes'
import type { Env } from '../src/index'
import type { WorkerConfig } from '../../types/config'
let mf: Miniflare, env: Env
const NOW = Math.floor(Date.now() / 60000) * 60
const base: WorkerConfig & { revision: number } = {
  revision: 1,
  monitors: [
    {
      id: 'web',
      name: 'Web',
      method: 'GET',
      target: 'https://private.invalid',
      probes: ['a'],
      notificationTemplateId: 'notice',
    },
  ],
  probes: [{ id: 'a', name: 'A' }],
  notificationTemplates: [
    {
      id: 'notice',
      name: 'Notice',
      type: 'webhook',
      webhook: {
        url: 'https://private.invalid/hook',
        payloadType: 'json',
        payload: { text: '$MSG' },
      },
    },
  ],
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
    UPTIMEFLARE_D1: await mf.getD1Database('UPTIMEFLARE_D1'),
    STATE_STORAGE_VERSION: '2',
  } as unknown as Env
  for (const sql of readFileSync(new URL('../../init.sql', import.meta.url), 'utf8')
    .split(';')
    .filter((s) => s.trim()))
    await env.UPTIMEFLARE_D1.prepare(sql).run()
}, 30000)
beforeEach(async () => {
  const tables = await env.UPTIMEFLARE_D1.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"
  ).all<{ name: string }>()
  for (const row of tables.results)
    await env.UPTIMEFLARE_D1.prepare('DELETE FROM ' + row.name).run()
  await env.UPTIMEFLARE_D1.prepare(
    'INSERT INTO admin_config(id,revision,value,updated_at) VALUES(1,1,?,?)'
  )
    .bind(JSON.stringify(base), NOW)
    .run()
})
afterAll(async () => {
  await mf?.dispose()
})
const count = async (table: string) =>
  Number(
    (await env.UPTIMEFLARE_D1.prepare('SELECT COUNT(*) n FROM ' + table).first<{ n: number }>())!.n
  )
it('packs200 samples across windows, keeps accurate weighted summaries and deduplicates lost ACK and overlapping batches', async () => {
  const results = Array.from({ length: 200 }, (_, i) => ({
    monitor_id: 'web',
    time: NOW - 600 + i,
    up: i % 3 !== 0,
    latency_ms: i,
    stage: 'tcp',
    code: 'refused',
    message: 'PRIVATE_REMOTE_ERROR',
  }))
  await persistBatch(env, 'a', results, [], undefined, 'batch-one')
  expect(await count('probe_samples')).toBe(0)
  const raw = await env.UPTIMEFLARE_D1.prepare('SELECT value FROM probe_result_blocks').all<{
    value: string
  }>()
  expect(raw.results.some((r) => r.value.includes('PRIVATE_REMOTE_ERROR'))).toBe(true)
  expect(await count('probe_result_blocks')).toBeLessThan(8)
  const summary = (await getProbeSummaries(env, base.monitors, base.probes, NOW)).web
  expect(summary.probes[0].checks).toBe(200)
  expect(summary.probes[0].failures).toBe(67)
  const incidents = await getProbeIncidents(env, base.monitors, base.probes, { limit: 100 }, NOW)
  expect(incidents.failures).toHaveLength(67)
  expect(JSON.stringify(incidents)).not.toContain('PRIVATE_REMOTE_ERROR')
  await persistBatch(env, 'a', results, [], undefined, 'batch-one')
  await persistBatch(env, 'a', results.slice(100), [], undefined, 'batch-overlap')
  expect((await getProbeSummaries(env, base.monitors, base.probes, NOW)).web.probes[0].checks).toBe(
    200
  )
  await expect(
    persistBatch(env, 'a', [{ ...results[0], up: true }], [], undefined, 'batch-one')
  ).rejects.toThrow('Conflicting')
})
it('updates current state and alert in one transaction, late backlog only extends history', async () => {
  await persistBatch(env, 'a', [
    { monitor_id: 'web', time: NOW, up: false, latency_ms: 5, stage: 'tcp', code: 'refused' },
  ])
  expect(await count('notification_outbox')).toBe(1)
  await persistBatch(env, 'a', [{ monitor_id: 'web', time: NOW - 300, up: true, latency_ms: 1 }])
  expect(
    (await env.UPTIMEFLARE_D1.prepare('SELECT up FROM probe_latest').first<{ up: number }>())!.up
  ).toBe(0)
  expect(await count('notification_outbox')).toBe(1)
  await env.UPTIMEFLARE_D1.prepare('DROP TABLE notification_outbox').run()
  try {
    await expect(
      persistBatch(env, 'a', [{ monitor_id: 'web', time: NOW + 60, up: true, latency_ms: 1 }])
    ).rejects.toThrow()
    expect(
      (await env.UPTIMEFLARE_D1.prepare('SELECT time FROM probe_latest').first<{ time: number }>())!
        .time
    ).toBe(NOW)
  } finally {
    // Restore only the dropped fixture table for subsequent tests.
    await env.UPTIMEFLARE_D1.prepare(
      readFileSync(new URL('../../init.sql', import.meta.url), 'utf8')
        .split(';')
        .find((s) => s.includes('CREATE TABLE IF NOT EXISTS notification_outbox'))!
    ).run()
  }
})
it('short commit lease expires, allows takeover, and conflicting ownership never confirms persistence', async () => {
  const lease = await beginCommit(env, 'first', { test: 1 }, base)
  await expect(beginCommit(env, 'second', { test: 2 }, base)).rejects.toThrow('busy')
  await env.UPTIMEFLARE_D1.prepare('UPDATE commit_leases SET lease_until=0').run()
  const second = await beginCommit(env, 'second', { test: 2 }, base)
  await releaseCommit(env, lease)
  expect(
    (await env.UPTIMEFLARE_D1.prepare('SELECT owner FROM commit_leases').first<{
      owner: string
    }>())!.owner
  ).toBe(second.owner)
  await releaseCommit(env, second)
})
it('keeps stable native rounds in hot rows, preserves incident start/reason changes and reads bounded cold history on demand', async () => {
  const config = {
    ...base,
    monitors: [{ ...base.monitors[0], probes: undefined, intervalSeconds: 60 }],
  }
  await env.UPTIMEFLARE_D1.prepare('UPDATE admin_config SET value=?')
    .bind(JSON.stringify(config))
    .run()
  let up = false,
    err = '[tcp/refused] Failed'
  const check = async (m: any) => ({ id: m.id, location: 'SIN', status: { up, ping: 0, err } })
  await runNativeMonitors(env, config, NOW, 'SIN', check)
  err = '[dns/not_found] Missing'
  await runNativeMonitors(env, config, NOW + 60, 'SIN', check)
  up = true
  err = ''
  await runNativeMonitors(env, config, NOW + 120, 'SIN', check)
  expect(await count('native_hot')).toBe(1)
  expect(await count('native_incidents')).toBe(1)
  expect(await count('native_incident_reasons')).toBe(2)
  expect(await count('uptimeflare')).toBe(0)
  const history = await getNativeIncidents(env, config.monitors, {}, NOW + 180)
  expect(history.incidents[0].start).toBe(NOW)
  expect(history.incidents[0].end).toBe(NOW + 120)
  expect(history.incidents[0].reasons).toHaveLength(2)
  const state = JSON.parse(
    (await publicNativeV2(env, config.monitors, true, NOW - 600, NOW + 180))!
  )
  expect(state.latency.web.time.length).toBe(24)
})
it('bounds UTF8 blocks independently of JavaScript character count', () => {
  const blocks = splitResultBlocks(
    Array.from({ length: 100 }, (_, i) => ({
      monitor_id: 'web',
      time: NOW + i,
      up: false,
      latency_ms: 1,
      stage: 'tcp',
      code: 'refused',
      message: '中文'.repeat(250),
    }))
  )
  expect(blocks.flat()).toHaveLength(100)
  expect(
    blocks.every((b) => new TextEncoder().encode(JSON.stringify(b)).byteLength <= MAX_BLOCK_BYTES)
  ).toBe(true)
})

it('retains probe system faults as raw gaps without changing counts or poisoning another valid target', async () => {
  await persistBatch(env, 'a', [{ monitor_id: 'web', time: NOW, up: true, latency_ms: 1 }])
  await persistBatch(env, 'a', [
    {
      monitor_id: 'web',
      time: NOW + 1,
      up: false,
      latency_ms: 0,
      stage: 'proxy',
      code: 'timeout',
      message: 'PRIVATE_PROXY_BODY',
    },
  ])
  const summary = (await getProbeSummaries(env, base.monitors, base.probes, NOW + 2)).web
  expect(summary.probes[0]).toMatchObject({ checks: 1, failures: 0, status: 'up', latest: NOW })
  expect(await count('probe_failure_events')).toBe(0)
  const raw = await env.UPTIMEFLARE_D1.prepare('SELECT value FROM probe_result_blocks').first<{
    value: string
  }>()
  expect(raw!.value).toContain('PRIVATE_PROXY_BODY')
})
it('paginates continued incidents by original start, even when their display starts are equal', async () => {
  const monitors = ['older', 'newer'].map((id) => ({
    id,
    name: id,
    method: 'GET',
    target: 'https://dummy.invalid',
  }))
  await env.UPTIMEFLARE_D1.batch([
    env.UPTIMEFLARE_D1.prepare("INSERT INTO native_incidents VALUES('older',?,NULL)").bind(
      NOW - 900
    ),
    env.UPTIMEFLARE_D1.prepare("INSERT INTO native_incidents VALUES('newer',?,NULL)").bind(
      NOW - 600
    ),
  ])
  const first = await getNativeIncidents(env, monitors, { from: NOW - 300, limit: 1 }, NOW)
  expect(first.incidents[0]).toMatchObject({
    monitorId: 'newer',
    start: NOW - 300,
    continued: true,
  })
  const second = await getNativeIncidents(
    env,
    monitors,
    { from: NOW - 300, limit: 1, cursor: first.nextCursor! },
    NOW
  )
  expect(second.incidents[0]).toMatchObject({
    monitorId: 'older',
    start: NOW - 300,
    continued: true,
  })
  expect(second.nextCursor).toBeNull()
})
