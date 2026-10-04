#!/usr/bin/env node
/** Exercise a fresh Worker artifact against bounded, disposable dashboard fixtures. */
import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { gzipSync } from 'node:zlib'
import { performance } from 'node:perf_hooks'
import { createHash } from 'node:crypto'
import Module from 'node:module'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const staticRoot = join(root, 'out')
const artifact = join(root, '.deployment/unified-worker/index.js')
const compiledWire = new Module(join(root, 'util/public-wire.ts'))
compiledWire._compile(
  ts.transpileModule(await readFile(compiledWire.id, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
  compiledWire.id
)
const { decodePublicWire } = compiledWire.exports
const origin = 'https://dashboard.test'
const targetCount = 500
const probeCount = 3
const pairCount = targetCount * probeCount
const targetsPerGroup = 20
const privateMarker = 'DASHBOARD_DUMMY_PRIVATE_CONFIGURATION'
const password = 'dashboard-smoke-admin-password-123456789'
const probes = Array.from({ length: probeCount }, (_, index) => ({
  id: `fixture-probe-${index}`,
  name: `Fixture probe ${index + 1}`,
  location: 'Fixture location',
}))
const probeTokens = Object.fromEntries(
  probes.map((probe) => [probe.id, `dashboard-fixture-${probe.id}-token-123456789`])
)

async function files(directory) {
  return (
    await Promise.all(
      (await readdir(directory, { withFileTypes: true })).map((entry) => {
        const path = join(directory, entry.name)
        return entry.isDirectory() ? files(path) : [path]
      })
    )
  ).flat()
}
const artifactTime = (await stat(artifact)).mtimeMs
const sourcePaths = (
  await Promise.all(
    ['worker/src', 'pages', 'types', 'util', 'components', 'locales', 'styles'].map((directory) =>
      files(join(root, directory))
    )
  )
)
  .flat()
  .filter((path) => /\.(?:tsx?|css|json)$/.test(path) && !path.includes('.test.'))
  .concat(join(root, 'compat/middleware.ts'), join(root, 'uptime.config.ts'))
assert.ok(
  (await Promise.all(sourcePaths.map((path) => stat(path)))).every(
    (value) => value.mtimeMs <= artifactTime
  ),
  'Build a fresh unified Worker artifact before running the dashboard smoke test'
)

// Only this fixture entry wraps the real D1 driver. The Worker module is unchanged.
// SELECT.first is observed through the same SELECT.all to obtain D1 row metadata.
const tracedEntry = `import pages from './index.js';
function traceDatabase(database, trace) {
  const underlying = new WeakMap();
  const statements = new WeakMap();
  const record = (sql, result) => {
    trace.queries++;
    trace.rowsRead += result.meta?.rows_read ?? 0;
    trace.rowsWritten += result.meta?.rows_written ?? 0;
    trace.rowsReturned += result.results?.length ?? 0;
    for (const match of sql.matchAll(/\\b(?:FROM|JOIN|INTO|UPDATE)\\s+([a-z_][a-z0-9_]*)/gi))
      if (match[1] !== 'json_each') trace.tables.add(match[1]);
  };
  const wrap = (statement, sql) => {
    const wrapped = new Proxy(statement, { get(target, property) {
      if (property === 'bind') return (...values) => wrap(target.bind(...values), sql);
      if (property === 'first') return async column => {
        const result = await target.all(); record(sql, result);
        const row = result.results?.[0];
        if (!row) return null;
        if (column === undefined) return row;
        if (!Object.prototype.hasOwnProperty.call(row, column)) throw new Error('Unknown first column');
        return row[column];
      };
      if (property === 'all' || property === 'run') return async (...args) => {
        const result = await target[property](...args); record(sql, result); return result;
      };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    }});
    underlying.set(wrapped, statement); statements.set(wrapped, sql); return wrapped;
  };
  return new Proxy(database, { get(target, property) {
    if (property === 'prepare') return sql => wrap(target.prepare(sql), sql);
    if (property === 'batch') return async prepared => {
      const results = await target.batch(prepared.map(statement => underlying.get(statement) ?? statement));
      results.forEach((result, index) => record(statements.get(prepared[index]) ?? '', result));
      return results;
    };
    const value = Reflect.get(target, property);
    return typeof value === 'function' ? value.bind(target) : value;
  }});
}
export default { async fetch(request, env, ctx) {
  const trace = {queries: 0, rowsRead: 0, rowsWritten: 0, rowsReturned: 0, tables: new Set()};
  const response = await pages.fetch(request, {...env, UPTIMEFLARE_D1: traceDatabase(env.UPTIMEFLARE_D1, trace)}, ctx);
  const headers = new Headers(response.headers);
  headers.set('X-Fixture-D1-Queries', String(trace.queries));
  headers.set('X-Fixture-D1-Rows-Read', String(trace.rowsRead));
  headers.set('X-Fixture-D1-Rows-Returned', String(trace.rowsReturned));
  headers.set('X-Fixture-D1-Rows-Written', String(trace.rowsWritten));
  headers.set('X-Fixture-D1-Tables', Array.from(trace.tables).sort().join(','));
  return new Response(response.body, {status: response.status, statusText: response.statusText, headers});
}};
`

const { Miniflare } = await import(
  pathToFileURL(join(root, 'worker/node_modules/miniflare/dist/src/index.js'))
)
const mf = new Miniflare({
  modules: [
    {
      type: 'ESModule',
      path: join(dirname(artifact), '__dashboard_fixture.mjs'),
      contents: tracedEntry,
    },
    ...(await files(dirname(artifact)))
      .filter((path) => path.endsWith('.js'))
      .map((path) => ({ type: 'ESModule', path })),
  ],
  modulesRoot: dirname(artifact),
  compatibilityDate: '2025-04-02',
  compatibilityFlags: ['nodejs_compat'],
  cf: { country: 'SG', city: 'Singapore', asn: 64512 },
  d1Databases: ['UPTIMEFLARE_D1'],
  bindings: {
    PROBE_TOKENS: JSON.stringify(probeTokens),
    ADMIN_PASSWORD: password,
    ADMIN_SESSION_SECRET: 'dashboard-smoke-session-secret-at-least-32-characters',
  },
  serviceBindings: {
    ASSETS: async (request) => {
      let pathname
      try {
        pathname = decodeURIComponent(new URL(request.url).pathname)
      } catch {
        return new Response(null, { status: 400 })
      }
      if (pathname.startsWith('/_worker.js')) return new Response(null, { status: 404 })
      const path = resolve(staticRoot, '.' + pathname)
      if (path !== staticRoot && !path.startsWith(staticRoot + sep))
        return new Response(null, { status: 404 })
      for (const candidate of [path, path + '.html', join(path, 'index.html')]) {
        try {
          if (!(await stat(candidate)).isFile()) continue
          const contentType = candidate.endsWith('.html')
            ? 'text/html; charset=utf-8'
            : candidate.endsWith('.js')
            ? 'application/javascript'
            : candidate.endsWith('.css')
            ? 'text/css'
            : candidate.endsWith('.svg')
            ? 'image/svg+xml'
            : candidate.endsWith('.png')
            ? 'image/png'
            : candidate.endsWith('.webp')
            ? 'image/webp'
            : 'application/octet-stream'
          return new Response(await readFile(candidate), {
            headers: { 'Content-Type': contentType },
          })
        } catch {
          // Match the Worker asset fallback; fixture worker modules are never served.
        }
      }
      return new Response(null, { status: 404 })
    },
  },
})

const forbiddenHistoryTables = [
  'probe_buckets',
  'probe_days',
  'probe_samples',
  'probe_stage_totals',
]
const measurements = []
let gateway
const browserRequests = { total: 0, history: 0, activeHistory: 0, maxConcurrentHistory: 0 }
function trace(headers) {
  return {
    queries: Number(headers.get('X-Fixture-D1-Queries')),
    rowsRead: Number(headers.get('X-Fixture-D1-Rows-Read')),
    rowsReturned: Number(headers.get('X-Fixture-D1-Rows-Returned')),
    rowsWritten: Number(headers.get('X-Fixture-D1-Rows-Written')),
    tables: (headers.get('X-Fixture-D1-Tables') ?? '').split(',').filter(Boolean),
  }
}
function privateFree(value) {
  const encoded = typeof value === 'string' ? value : JSON.stringify(value)
  for (const forbidden of [privateMarker, ...Object.values(probeTokens), password])
    assert.ok(
      !encoded.includes(forbidden),
      'Public output must not contain fixture configuration secrets'
    )
}
async function request(path, expected = 200, options = {}) {
  const started = performance.now()
  const response = await mf.dispatchFetch(origin + path, options)
  assert.equal(response.status, expected, `${path}: unexpected HTTP status`)
  const encoded = await response.text()
  const measured = {
    path,
    status: response.status,
    rawBytes: Buffer.byteLength(encoded),
    gzipBytes: gzipSync(encoded).length,
    elapsedMs: Number((performance.now() - started).toFixed(2)),
    ...trace(response.headers),
  }
  measurements.push(measured)
  return { encoded, measured, response }
}
function pageProps(encoded) {
  const match = /<script\b[^>]*\bid="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(encoded)
  assert.ok(match, 'Expected serialized Next page props')
  return JSON.parse(match[1]).props.pageProps
}
function lightweight(summaries) {
  for (const summary of Object.values(summaries)) {
    assert.ok(
      summary.historyLoaded === false,
      'Dashboard must explicitly identify unloaded history'
    )
    assert.ok(
      Array.isArray(summary.dailyHistory) && summary.dailyHistory.length === 0,
      'Dashboard must not serialize aggregate daily history'
    )
    for (const probe of summary.probes) {
      assert.ok(
        Array.isArray(probe.history) && probe.history.length === 0,
        'Dashboard must not serialize short history'
      )
      assert.ok(
        Array.isArray(probe.dailyHistory) && probe.dailyHistory.length === 0,
        'Dashboard must not serialize probe daily history'
      )
      assert.ok(
        Array.isArray(probe.recentFailures) && probe.recentFailures.length === 0,
        'Dashboard must not serialize recent failures'
      )
    }
  }
}
function noHistoryRead(measured) {
  assert.equal(measured.rowsWritten, 0, 'Public reads must not write configuration or history')
  for (const table of forbiddenHistoryTables)
    assert.ok(!measured.tables.includes(table), `Lightweight requests must not query ${table}`)
}

try {
  const db = await mf.getD1Database('UPTIMEFLARE_D1')
  for (const sql of (await readFile(join(root, 'init.sql'), 'utf8'))
    .split(';')
    .filter((sql) => sql.trim()))
    await db.prepare(sql).run()
  const now = Math.floor(Date.now() / 1000)
  const minute = Math.floor(now / 300) * 300
  const day = Math.floor(now / 86400) * 86400
  const monitors = Array.from({ length: targetCount }, (_, index) => ({
    id: `fixture-target-${String(index).padStart(3, '0')}`,
    name: `Dummy target ${String(index).padStart(3, '0')}`,
    method: 'GET',
    target: `https://fixture.invalid/${privateMarker}/${index}`,
    probes: probes.map((probe) => probe.id),
    intervalSeconds: 300,
    timeout: 5000,
    headers: { Authorization: privateMarker },
    body: privateMarker,
  }))
  const groups = Object.fromEntries(
    Array.from({ length: targetCount / targetsPerGroup }, (_, index) => [
      `Fixture group ${index}`,
      monitors
        .slice(index * targetsPerGroup, (index + 1) * targetsPerGroup)
        .map((monitor) => monitor.id),
    ])
  )
  const config = {
    monitors,
    probes,
    page: { title: 'Dashboard performance fixture', group: groups, links: [] },
    notificationTemplates: [],
    maintenances: [],
    notification: {},
    _groupIds: Object.fromEntries(Object.keys(groups).map((name) => [name, crypto.randomUUID()])),
  }
  await db
    .prepare('INSERT INTO admin_config(id,revision,value,updated_at) VALUES(1,1,?,?)')
    .bind(JSON.stringify(config), now)
    .run()

  const seeded = {}
  async function seed(table, columns, rows) {
    let statements = []
    for (let offset = 0; offset < rows.length; offset += 256) {
      const chunk = rows.slice(offset, offset + 256)
      const projection = columns.map((_, index) => `json_extract(value,'$[${index}]')`).join(',')
      statements.push(
        db
          .prepare(
            `INSERT INTO ${table}(${columns.join(',')}) SELECT ${projection} FROM json_each(?)`
          )
          .bind(JSON.stringify(chunk))
      )
      if (statements.length === 8 || offset + 256 >= rows.length) {
        const results = await db.batch(statements)
        assert.ok(
          results.every((result) => result.success),
          `Fixture seeding failed for ${table}`
        )
        statements = []
      }
    }
    seeded[table] = rows.length
  }
  const pairs = monitors.flatMap((monitor) => probes.map((probe) => [probe.id, monitor.id]))
  await seed(
    'probe_latest',
    ['probe_id', 'monitor_id', 'time', 'up', 'latency_ms', 'stage', 'code', 'message'],
    pairs.map(([probe, monitor]) => [probe, monitor, now, 1, 12, '', '', ''])
  )
  await seed(
    'probe_totals',
    ['probe_id', 'monitor_id', 'checks', 'failures', 'latency_sum'],
    pairs.map(([probe, monitor]) => [probe, monitor, 90 * 288, 100, (90 * 288 - 100) * 12])
  )
  await seed(
    'probe_buckets',
    ['probe_id', 'monitor_id', 'time', 'checks', 'failures', 'latency_sum'],
    pairs.flatMap(([probe, monitor]) =>
      Array.from({ length: 144 }, (_, index) => [
        probe,
        monitor,
        minute - index * 300,
        1,
        index > 0 && index <= 100 ? 1 : 0,
        index > 0 && index <= 100 ? 0 : 12,
      ])
    )
  )
  await seed(
    'probe_days',
    ['probe_id', 'monitor_id', 'time', 'checks', 'failures', 'latency_checks', 'latency_sum'],
    pairs.flatMap(([probe, monitor]) =>
      Array.from({ length: 90 }, (_, index) => [
        probe,
        monitor,
        day - index * 86400,
        288,
        index ? 0 : 100,
        index ? 288 : 188,
        (index ? 288 : 188) * 12,
      ])
    )
  )
  await seed(
    'probe_samples',
    ['probe_id', 'monitor_id', 'time', 'up', 'latency_ms', 'stage', 'code', 'message'],
    pairs.flatMap(([probe, monitor]) =>
      Array.from({ length: 100 }, (_, index) => [
        probe,
        monitor,
        minute - (index + 1) * 300,
        0,
        0,
        'tcp',
        'refused',
        'Dummy bounded connection failure',
      ])
    )
  )
  await seed(
    'probe_stage_totals',
    ['probe_id', 'monitor_id', 'stage', 'failures'],
    pairs.map(([probe, monitor]) => [probe, monitor, 'tcp', 100])
  )

  const data = await request('/api/data')
  const dataValue = JSON.parse(data.encoded)
  assert.equal(Object.keys(dataValue.monitors).length, targetCount)
  assert.ok(
    data.measured.rawBytes <= 256 * 1024,
    '500-target dashboard JSON must remain below 256 KiB'
  )
  privateFree(data.encoded)
  assert.ok(
    dataValue.projection === 'current-summary',
    'Large legacy response must degrade to a bounded current summary'
  )
  noHistoryRead(data.measured)

  const home = await request('/')
  assert.deepEqual(
    pageProps(home.encoded),
    {},
    'Static shell contains no private or dynamic configuration'
  )
  const state = await request('/api/state')
  const props = decodePublicWire(JSON.parse(state.encoded))
  assert.equal(props.monitors.length, targetCount)
  assert.ok(state.measured.rawBytes <= 256 * 1024)
  noHistoryRead(state.measured)
  assert.ok(
    state.measured.rawBytes <= 256 * 1024,
    '500-target summary wire must remain below 256 KiB'
  )
  assert.equal(
    (home.encoded.match(/<canvas\b/g) ?? []).length,
    0,
    'Initial HTML must not mount charts'
  )
  assert.ok(
    !home.encoded.includes('data-history-timeline') &&
      !home.encoded.includes('HistoryTimeline_timeline'),
    'Initial HTML must not mount historical timelines'
  )
  assert.ok(
    props.compactedStateStr === null,
    'External-only dashboards must not read or serialize native state'
  )
  lightweight(props.probeSummaries)
  privateFree(home.encoded)
  noHistoryRead(home.measured)

  const id = monitors[0].id
  const history = await request(`/api/history?id=${encodeURIComponent(id)}`)
  const detail = JSON.parse(history.encoded)
  assert.ok(detail.monitorId === id, 'History response must identify the requested target')
  assert.ok(detail.summary.monitorId === id, 'History summary must identify the requested target')
  assert.ok(detail.summary.historyLoaded === true, 'History response must identify loaded history')
  assert.equal(detail.summary.probes.length, probeCount)
  for (const probe of detail.summary.probes) {
    assert.equal(probe.history.length, 144, 'Single-target history must retain short buckets')
    assert.equal(probe.dailyHistory.length, 90, 'Single-target history must retain daily buckets')
    assert.equal(
      probe.recentFailures.length,
      100,
      'Single-target history must retain bounded diagnostics'
    )
  }
  assert.ok(history.measured.rowsReturned < 1500, 'History must be scoped to one target')
  privateFree(history.encoded)
  await request(`/api/history?id=${id}&id=${id}`, 400)
  await request(`/api/history?id=${id}&extra=1`, 400)

  async function pause(indices) {
    await db
      .prepare('UPDATE admin_config SET revision=revision+1,value=? WHERE id=1')
      .bind(
        JSON.stringify({
          ...config,
          monitors: monitors.map((monitor, index) =>
            indices.has(index) ? { ...monitor, paused: true } : monitor
          ),
        })
      )
      .run()
  }
  await pause(new Set(Array.from({ length: targetsPerGroup }, (_, index) => index)))
  const partiallyPaused = await request('/')
  const renderedPartial = partiallyPaused.encoded.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
  assert.ok(!renderedPartial.includes('Fixture group 0'), 'Entirely paused groups must disappear')
  assert.ok(
    !renderedPartial.includes(monitors[0].name),
    'Paused targets must disappear from homepage markup'
  )
  noHistoryRead(partiallyPaused.measured)
  const hiddenHistory = await request(`/api/history?id=${id}`, 404)
  noHistoryRead(hiddenHistory.measured)
  const pausedRows = await db.prepare('SELECT COUNT(*) count FROM probe_samples').first()
  assert.equal(
    pausedRows.count,
    seeded.probe_samples,
    'Pausing must retain stored historical samples'
  )

  await pause(new Set(Array.from({ length: targetCount }, (_, index) => index)))
  const closed = await request('/api/data')
  const closedValue = JSON.parse(closed.encoded)
  assert.equal(closedValue.paused, targetCount)
  assert.ok(closed.measured.rawBytes < 120 * 1024, 'All-paused API must remain minimal')
  assert.ok(
    closed.measured.tables.every(
      (table) => table === 'probe_metadata' || !table.startsWith('probe_')
    ),
    'All-paused dashboard must not query probe observations or histories'
  )
  noHistoryRead(closed.measured)
  const emptyHome = await request('/')
  const renderedEmpty = emptyHome.encoded.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
  assert.ok(
    !renderedEmpty.includes('Dummy target'),
    'All-paused homepage must not render target cards'
  )
  assert.ok(!renderedEmpty.includes('Fixture group'), 'All-paused homepage must not render groups')
  noHistoryRead(emptyHome.measured)
  privateFree(emptyHome.encoded)

  console.log(
    JSON.stringify(
      {
        passed: true,
        actualWorkerArtifact: true,
        artifactSha256: createHash('sha256')
          .update(await readFile(artifact))
          .digest('hex'),
        disposableD1: true,
        targets: targetCount,
        probes: probeCount,
        assignments: pairCount,
        groups: targetCount / targetsPerGroup,
        targetsPerGroup,
        seeded,
        firstObservedSelectsUseAllForD1Metadata: true,
        gzipBytesAreLocalCompressionMeasurements: true,
        measurements,
      },
      null,
      2
    )
  )

  if (process.argv.includes('--preview')) {
    await db
      .prepare('UPDATE admin_config SET revision=1,value=? WHERE id=1')
      .bind(JSON.stringify(config))
      .run()
    gateway = createServer(async (incoming, outgoing) => {
      if (incoming.url === '/__fixture/stats') {
        outgoing.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        outgoing.end(JSON.stringify(browserRequests))
        return
      }
      const historical = incoming.url.startsWith('/api/history?')
      browserRequests.total++
      if (historical) {
        browserRequests.history++
        browserRequests.activeHistory++
        browserRequests.maxConcurrentHistory = Math.max(
          browserRequests.maxConcurrentHistory,
          browserRequests.activeHistory
        )
      }
      try {
        const chunks = []
        let size = 0
        for await (const chunk of incoming) {
          size += chunk.length
          if (size > 128 * 1024) throw new Error('Fixture request too large')
          chunks.push(chunk)
        }
        const headers = { ...incoming.headers, host: 'dashboard.test' }
        if (headers.origin === 'http://127.0.0.1:8794') headers.origin = origin
        const bytes = Buffer.concat(chunks)
        const response = await mf.dispatchFetch(origin + incoming.url, {
          method: incoming.method,
          headers,
          ...(bytes.length ? { body: bytes } : {}),
        })
        outgoing.writeHead(response.status, Object.fromEntries(response.headers))
        outgoing.end(Buffer.from(await response.arrayBuffer()))
      } catch {
        outgoing.writeHead(500)
        outgoing.end('Fixture gateway failed')
      } finally {
        if (historical) browserRequests.activeHistory--
      }
    })
    await new Promise((resolve) => gateway.listen(8794, '127.0.0.1', resolve))
    console.log(
      'Dummy dashboard preview: http://127.0.0.1:8794/; request counters: /__fixture/stats'
    )
    const stop = () => {
      gateway.close()
      mf.dispose().finally(() => process.exit(0))
    }
    process.once('SIGTERM', stop)
    process.once('SIGINT', stop)
    await new Promise(() => {})
  }
} finally {
  gateway?.close()
  await mf.dispose()
}
