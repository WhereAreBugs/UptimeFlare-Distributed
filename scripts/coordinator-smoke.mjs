#!/usr/bin/env node
/** Local real RPC, disposable D1/KV/DO storage, and intercepted target HTTP only. */
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { gzipSync } from 'node:zlib'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..'),
  artifact = join(root, '.deployment/unified-worker/index.js')
const { Miniflare, Log, LogLevel } = await import(
  pathToFileURL(join(root, 'worker/node_modules/miniflare/dist/src/index.js'))
)
const persistence = await mkdtemp(join(tmpdir(), 'uptimeflare-coordination-'))
const fixture = `import worker from './index.js'; export {Coordinator,RemoteChecker} from './index.js';
export default {async fetch(req,env){
 const u=new URL(req.url);const start=performance.now();
 if(u.pathname==='/_fixture/status'){const stub=env.COORDINATOR_DO.get(env.COORDINATOR_DO.idFromName('state-v2'));const result=await stub.status(u.searchParams.get('id'));return Response.json({result,rpcWallMs:performance.now()-start})}
 if(u.pathname==='/_fixture/materialize'){const stub=env.COORDINATOR_DO.get(env.COORDINATOR_DO.idFromName('state-v2'));await stub.materialize(Number(u.searchParams.get('time')));return Response.json({rpcWallMs:performance.now()-start})}
 if(u.pathname==='/_fixture/region'){const request=await req.json();const stub=env.REMOTE_CHECKER_DO.get(env.REMOTE_CHECKER_DO.idFromName('region:apac'));const result=await stub.checkBatch(request);return Response.json({result,rpcWallMs:performance.now()-start})}
 return worker.fetch(req,env)
}};`
const resources = []
const output = process.stdout.write.bind(process.stdout)
process.stdout.write = function (chunk, ...args) {
  for (const line of String(chunk).split('\n')) {
    try {
      const item = JSON.parse(line)
      if (item.event === 'resource_counts') resources.push(item)
    } catch {}
  }
  const callback = args.find((value) => typeof value === 'function')
  callback?.()
  return true
}
class CaptureLog extends Log {
  constructor() {
    super(LogLevel.INFO)
  }
  log(message) {
    const begin = message.indexOf('{')
    if (begin >= 0) {
      try {
        const v = JSON.parse(message.slice(begin))
        if (v.event === 'resource_counts') resources.push(v)
      } catch {}
    }
  }
}
let outbound = 0,
  locations = 0,
  mf
const options = {
  modules: [
    {
      type: 'ESModule',
      path: join(dirname(artifact), '__coordinator_fixture.mjs'),
      contents: fixture,
    },
    { type: 'ESModule', path: artifact },
  ],
  modulesRoot: dirname(artifact),
  compatibilityDate: '2025-04-02',
  compatibilityFlags: ['nodejs_compat'],
  d1Databases: ['UPTIMEFLARE_D1'],
  kvNamespaces: ['UPTIMEFLARE_PUBLIC_KV'],
  durableObjects: {
    COORDINATOR_DO: { className: 'Coordinator', useSQLite: true },
    REMOTE_CHECKER_DO: { className: 'RemoteChecker', useSQLite: true },
  },
  d1Persist: join(persistence, 'd1'),
  kvPersist: join(persistence, 'kv'),
  durableObjectsPersist: join(persistence, 'do'),
  bindings: {
    STATE_STORAGE_VERSION: '2',
    PACKED_PROBE_COUNTERS: '1',
    METRICS_ENABLED: '1',
    PROBE_TOKENS: JSON.stringify({ a: 'fixture-secret-token-1234567890' }),
  },
  log: new CaptureLog(),
  outboundService: async (request) => {
    outbound++
    if (new URL(request.url).pathname.includes('/cdn-cgi/trace')) {
      locations++
      return new Response('colo=SIN\n')
    }
    return new Response('OK')
  },
}
const now = Math.floor(Date.now() / 300000) * 300
const monitors = Array.from({ length: 10 }, (_, i) => ({
  id: 't' + i,
  name: 'Target ' + i,
  method: 'GET',
  target: 'https://target.fixture/ok',
  probes: ['a'],
}))
const batch = {
  version: 1,
  batch_id: 'c'.repeat(64),
  results: Array.from({ length: 200 }, (_, i) => ({
    monitor_id: 't' + (i % 10),
    time: now - Math.floor(i / 10),
    up: true,
    latency_ms: i,
  })),
}
const origin = 'https://coordination.fixture'
async function request(path, init = {}) {
  const start = performance.now(),
    response = await mf.dispatchFetch(origin + path, init),
    body = await response.json()
  assert.equal(response.status, 200, JSON.stringify(body))
  return { body, wallDurationMs: performance.now() - start }
}
const ingest = () =>
  request('/api/probes/ingest', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer fixture-secret-token-1234567890',
      'X-Probe-ID': 'a',
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
    },
    body: gzipSync(JSON.stringify(batch)),
  })
try {
  mf = new Miniflare(options)
  const db = await mf.getD1Database('UPTIMEFLARE_D1')
  for (const sql of (await readFile(join(root, 'init.sql'), 'utf8'))
    .split(';')
    .filter((s) => s.trim()))
    await db.prepare(sql).run()
  await db
    .prepare('INSERT INTO admin_config VALUES(1,1,?,?)')
    .bind(
      JSON.stringify({
        monitors,
        probes: [{ id: 'a', name: 'Fixture' }],
        page: { title: 'Fixture' },
      }),
      now
    )
    .run()
  const first = await ingest()
  assert.equal(first.body.accepted, 200)
  const replay = await ingest()
  assert.equal(replay.body.accepted, 200)
  const status = await request('/_fixture/status?id=probe:a:' + batch.batch_id)
  assert.equal(status.body.result.committed, true)
  const packed = await db.prepare('SELECT COUNT(*) count FROM probe_result_blocks').first()
  assert.ok(packed.count >= 1 && packed.count <= 2)
  const legacy = await db.prepare('SELECT COUNT(*) count FROM probe_samples').first()
  assert.equal(legacy.count, 0)
  await request('/_fixture/materialize?time=' + now)
  const state = await request('/api/state')
  assert.equal(state.body.monitors.length, 10)
  assert.equal(state.body.source, 'kv')
  const regionalMonitors = monitors.map(({ probes, ...m }) => m)
  const { createHash } = await import('node:crypto')
  const configVersion = createHash('sha256').update(JSON.stringify(regionalMonitors)).digest('hex')
  const region = () =>
    request('/_fixture/region', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        version: 1,
        runId: 'regional-fixture',
        configVersion,
        monitors: regionalMonitors,
      }),
    })
  const [ra, rb] = await Promise.all([region(), region()])
  assert.equal(ra.body.result.results.length, 10)
  assert.ok(rb.body.result.results.every((r) => r.status.up))
  assert.equal(locations, 1)
  await mf.dispose()
  mf = new Miniflare(options)
  const reconstructed = await request('/_fixture/status?id=probe:a:' + batch.batch_id)
  assert.equal(reconstructed.body.result.committed, true)
  await ingest()
  const restored = await mf.getD1Database('UPTIMEFLARE_D1')
  assert.equal(
    (
      await restored
        .prepare(
          "SELECT json_extract(value,'$.monitors.t0.checks') checks FROM uptimeflare WHERE key=?"
        )
        .bind('probe-counters:v1:a')
        .first()
    ).checks,
    20
  )
  await region()
  assert.equal(locations, 2, 'Object reconstruction refreshes ephemeral location safely')
  const conflict = await mf.dispatchFetch(origin + '/api/probes/ingest', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer fixture-secret-token-1234567890',
      'X-Probe-ID': 'a',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ...batch,
      results: [{ ...batch.results[0], up: false, stage: 'tcp', code: 'refused' }],
    }),
  })
  assert.equal(conflict.status, 503)
  assert.ok(resources.some((r) => r.scope === 'root-fetch' && r.doRequests >= 1))
  assert.ok(resources.some((r) => r.scope === 'coordinator' && r.sql > 0))
  output(
    JSON.stringify(
      {
        passed: true,
        actualWorkerArtifact: true,
        realDurableObjectRpc: true,
        reconstructed: true,
        first: first.wallDurationMs,
        replay: replay.wallDurationMs,
        statusRpcWallMs: status.body.rpcWallMs,
        regionalRpcWallMs: [ra.body.rpcWallMs, rb.body.rpcWallMs],
        targetRequests: outbound - locationCount(),
        locationRequests: locations,
        resourceRecords: resources,
        cpuMs: null,
      },
      null,
      2
    ) + '\n'
  )
} finally {
  process.stdout.write = output
  await mf?.dispose()
  await rm(persistence, { recursive: true, force: true })
}
function locationCount() {
  return locations
}
