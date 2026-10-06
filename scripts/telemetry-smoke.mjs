#!/usr/bin/env node
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { Miniflare } from '../worker/node_modules/miniflare/dist/src/index.js'
const exports = []
const mf = new Miniflare({
  modules: true,
  scriptPath: new URL('../.deployment/unified-worker/index.js', import.meta.url).pathname,
  compatibilityDate: '2025-04-02',
  compatibilityFlags: ['nodejs_compat'],
  d1Databases: ['UPTIMEFLARE_D1'],
  kvNamespaces: ['UPTIMEFLARE_PUBLIC_KV'],
  durableObjects: {
    COORDINATOR_DO: { className: 'Coordinator', useSQLite: true },
    REMOTE_CHECKER_DO: { className: 'RemoteChecker', useSQLite: true },
  },
  bindings: {
    STATE_STORAGE_VERSION: '2',
    PACKED_PROBE_COUNTERS: '1',
    TELEMETRY_ENABLED: '1',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.fixture/api/default',
    OTEL_EXPORTER_OTLP_HEADERS: '{}',
    OTEL_TRACES_SAMPLER_ARG: '1',
    PROBE_TOKENS: JSON.stringify({ a: 'fixture-secret-token-1234567890' }),
  },
  outboundService: async (req) => {
    assert.equal(new URL(req.url).hostname, 'collector.fixture')
    const bytes = await req.arrayBuffer()
    exports.push(JSON.parse(gunzipSync(new Uint8Array(bytes)).toString()))
    return new Response('{}')
  },
})
try {
  const db = await mf.getD1Database('UPTIMEFLARE_D1')
  for (const sql of (await readFile(new URL('../init.sql', import.meta.url), 'utf8'))
    .split(';')
    .filter((s) => s.trim()))
    await db.prepare(sql).run()
  await db.prepare('INSERT INTO storage_versions VALUES(1,2,unixepoch())').run()
  const cfg = {
    revision: 1,
    probes: [{ id: 'a' }],
    monitors: [
      {
        id: 'a-target',
        name: 'Target',
        target: 'https://SECRET-TARGET.invalid',
        method: 'GET',
        probes: ['a'],
      },
    ],
  }
  await db
    .prepare('INSERT INTO admin_config VALUES(1,1,?,unixepoch())')
    .bind(JSON.stringify(cfg))
    .run()
  const response = await mf.dispatchFetch('https://status.fixture/api/probes/ingest', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer fixture-secret-token-1234567890',
      'Content-Type': 'application/json',
      traceparent: '00-11111111111111111111111111111111-2222222222222222-01',
    },
    body: JSON.stringify({
      version: 1,
      batch_id: 'a'.repeat(64),
      results: [
        { monitor_id: 'a-target', time: Math.floor(Date.now() / 1000), up: true, latency_ms: 2 },
      ],
    }),
  })
  assert.equal(response.status, 200)
  await response.json()
  for (
    let i = 0;
    i < 80 &&
    !(
      exports.some((x) => x.resourceMetrics) &&
      exports.some((x) =>
        x.resourceSpans?.some((r) =>
          r.scopeSpans.some((s) => s.spans.some((v) => v.name === 'worker.fetch'))
        )
      )
    );
    i++
  )
    await new Promise((r) => setTimeout(r, 50))
  const spans = exports.flatMap(
    (x) => x.resourceSpans?.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)) ?? []
  )
  const root = spans.find((s) => s.name === 'worker.fetch'),
    rpc = spans.find((s) => s.name === 'rpc.commitProbe'),
    coordinator = spans.find((s) => s.name === 'coordinator.commitProbe')
  assert.ok(root && rpc && coordinator)
  assert.equal(root.parentSpanId, '2222222222222222')
  assert.equal(rpc.parentSpanId, root.spanId)
  assert.equal(coordinator.parentSpanId, rpc.spanId)
  assert.ok(spans.some((s) => s.name === 'd1.batch' && s.traceId === root.traceId))
  assert.ok(exports.some((x) => x.resourceMetrics))
  assert.ok(!JSON.stringify(exports).includes('SECRET-TARGET'))
  assert.equal((await db.prepare('SELECT count(*) n FROM commit_runs').first()).n, 1)
  console.log(
    'Real Worker/Coordinator/D1 trace propagation, gzip export, durable ACK and privacy passed'
  )
} finally {
  await mf.dispose()
}
