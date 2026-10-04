#!/usr/bin/env node
/** Verify real Worker KV bindings without D1, using disposable public fixtures only. */
import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import Module from 'node:module'
import ts from 'typescript'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const staticRoot = join(root, 'out')
const artifact = join(root, '.deployment/unified-worker/index.js')
const origin = 'https://public-cache.test'
const previewOrigin = 'http://127.0.0.1:8796'
const secrets = [
  'PUBLIC_CACHE_DUMMY_PRIVATE_TARGET',
  'public-cache-smoke-admin-password-123456789',
  'public-cache-smoke-session-secret-at-least-32-characters',
  'public-cache-smoke-probe-token-at-least-24-characters',
]
let checks = 0
const check = (condition, message) => {
  checks++
  assert.ok(condition, message)
}
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
const sources = (
  await Promise.all(
    ['worker/src', 'pages', 'types', 'util', 'components', 'locales', 'styles'].map((directory) =>
      files(join(root, directory))
    )
  )
)
  .flat()
  .filter((path) => /\.(?:tsx?|css|json)$/.test(path) && !path.includes('.test.'))
  .concat(join(root, 'compat/middleware.ts'), join(root, 'uptime.config.ts'))
check(
  (await Promise.all(sources.map((path) => stat(path)))).every(
    (value) => value.mtimeMs <= artifactTime
  ),
  'Build a fresh unified Worker artifact before running the public cache smoke test'
)

const { Miniflare } = await import(
  pathToFileURL(join(root, 'worker/node_modules/miniflare/dist/src/index.js'))
)
const modules = (await files(dirname(artifact)))
  .filter((path) => path.endsWith('.js'))
  .sort((a, b) => (a === artifact ? -1 : b === artifact ? 1 : a.localeCompare(b)))
  .map((path) => ({ type: 'ESModule', path }))
const monitors = Array.from({ length: 74 }, (_, index) => ({
  id: `fixture-target-${String(index).padStart(3, '0')}`,
  name: index < 69 ? `Dummy Mac target ${index}` : `Dummy other target ${index}`,
  intervalSeconds: 300,
  probes: ['cloudflare', 'fixture-p1', 'fixture-p2'],
  ...(index < 58 && { paused: true }),
  // Deliberate dummy private fields verify allowlisting on consumption, never real credentials.
  target: `https://fixture.invalid/${secrets[0]}`,
  headers: { Authorization: secrets[0] },
  notificationTemplates: [secrets[0]],
}))
const groups = {
  'Dummy Mac group': monitors.slice(0, 69).map((monitor) => monitor.id),
  'Dummy wholly paused group': monitors.slice(0, 58).map((monitor) => monitor.id),
  'Dummy other group': monitors.slice(69).map((monitor) => monitor.id),
}
const fixtureSnapshot = (complete = false) => {
  const now = Math.floor(Date.now() / 1000)
  return {
    version: 1,
    generatedAt: now - (complete ? 240 : 0),
    configRevision: 14,
    complete,
    monitors,
    page: { title: 'Public snapshot fixture', group: groups, links: [] },
    maintenances: [],
    compactedStateStr: null,
    probeSummaries: Object.fromEntries(
      monitors.map((monitor) => [
        monitor.id,
        {
          monitorId: monitor.id,
          status: 'up',
          up: 3,
          down: 0,
          unknown: 0,
          total: 3,
          latest: now,
          uptimePercent: 100,
          probes: monitor.probes.map((id) => ({
            id,
            name:
              id === 'cloudflare'
                ? 'Cloudflare'
                : id === 'fixture-p1'
                ? 'Dummy probe 1'
                : 'Dummy probe 2',
            status: 'up',
            stale: false,
            latest: now,
            latencyMs: 12,
          })),
        },
      ])
    ),
  }
}
async function assets(request) {
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
  // This test must exercise KV, even when the fresh artifact also contains a recovery asset.
  if (pathname === '/public-dashboard-recovery.json') return new Response(null, { status: 404 })
  for (const candidate of [path, path + '.html', join(path, 'index.html')]) {
    try {
      if (!(await stat(candidate)).isFile()) continue
      const type = candidate.endsWith('.html')
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
        : candidate.endsWith('.json')
        ? 'application/json'
        : 'application/octet-stream'
      return new Response(await readFile(candidate), { headers: { 'Content-Type': type } })
    } catch {
      /* Match Worker asset fallbacks. */
    }
  }
  return new Response(null, { status: 404 })
}
async function instance(snapshot) {
  const mf = new Miniflare({
    modules,
    modulesRoot: dirname(artifact),
    compatibilityDate: '2025-04-02',
    compatibilityFlags: ['nodejs_compat'],
    cf: { country: 'SG', city: 'Singapore', asn: 64512 },
    kvNamespaces: ['UPTIMEFLARE_PUBLIC_KV'],
    // Only KV and ASSETS resource bindings. Dummy scalar credentials allow real 401 checks.
    bindings: {
      ADMIN_PASSWORD: secrets[1],
      ADMIN_SESSION_SECRET: secrets[2],
      PROBE_TOKENS: JSON.stringify({ 'fixture-p1': secrets[3] }),
    },
    serviceBindings: { ASSETS: assets },
  })
  try {
    const kv = await mf.getKVNamespace('UPTIMEFLARE_PUBLIC_KV')
    await kv.put('public-dashboard:v1', JSON.stringify(snapshot))
    return mf
  } catch (error) {
    await mf.dispose()
    throw error
  }
}
function privateFree(value) {
  const encoded = typeof value === 'string' ? value : JSON.stringify(value)
  for (const secret of secrets)
    check(!encoded.includes(secret), 'Public output must not contain dummy private configuration')
  for (const key of [
    'checkProxyHeaders',
    'notificationTemplates',
    'ADMIN_PASSWORD',
    'ADMIN_SESSION_SECRET',
    'PROBE_TOKENS',
    'tokenHash',
  ])
    check(!encoded.includes(`"${key}"`), `Public output must not expose private field ${key}`)
}
function pageProps(html) {
  const match = /<script\b[^>]*\bid="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(html)
  check(!!match, 'Expected actual Next page props')
  return JSON.parse(match[1]).props.pageProps
}
async function loadListHelpers() {
  const filename = join(root, 'util/public-monitor-list.ts')
  const compiled = new Module(filename)
  compiled._compile(
    ts.transpileModule(await readFile(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    filename
  )
  return compiled.exports
}
const list = await loadListHelpers()
const reports = []
async function publicChecks(mf, snapshot) {
  const responses = []
  for (const path of ['/', '/api/data']) {
    const response = await mf.dispatchFetch(origin + path)
    check(response.status === 200, `${path} must succeed with no D1 binding`)
    const body = await response.text()
    privateFree(body)
    responses.push({
      path,
      body,
      rawBytes: Buffer.byteLength(body),
      gzipBytes: gzipSync(body).length,
    })
  }
  const props = pageProps(responses[0].body)
  const data = JSON.parse(responses[1].body)
  for (const value of [props, data]) {
    check(value.source === 'kv', 'Actual Worker env must resolve the KV binding')
    check(
      value.snapshotAt === snapshot.generatedAt,
      'Generated time must come from the seeded snapshot'
    )
    check(value.snapshotIncomplete === !snapshot.complete, 'Snapshot completeness must be explicit')
    check(value.stale === true, 'Incomplete and expired snapshots are stale')
  }
  check(
    data.total === 74 && data.closed === 58 && data.paused === 58,
    'Closed targets remain in the 74-target total'
  )
  check(
    data.unknown === 16 &&
      data.abnormal === 16 &&
      data.healthy === 0 &&
      data.up === 0 &&
      data.down === 0,
    'All 16 active targets must be unknown, including retained recent successes'
  )
  for (const monitor of monitors) {
    const value = data.monitors[monitor.id]
    check(
      value.status === (monitor.paused ? 'paused' : 'unknown'),
      'Lifecycle and unavailable state must remain distinct'
    )
    check(value.up === null, 'Unknown and paused current reachability is not a successful result')
    if (!monitor.paused) {
      check(
        value.probes.length === 3 &&
          value.probes.every((probe) => probe.status === 'unknown' && probe.stale),
        'Independent probe badges cannot revive stale successes'
      )
      check(
        value.historyLoaded === false &&
          value.probes.every((probe) => !probe.history.length && !probe.dailyHistory.length),
        'Dashboard must not serialize historical rows'
      )
    }
  }
  const active = list.visiblePublicMonitors(props.monitors, props.probeSummaries)
  const renderedGroups = list.publicMonitorGroups(active, props.page.group, 'Other')
  check(
    active.length === 16 && active.every((monitor) => !monitor.paused),
    'Public rendering input excludes every paused target'
  )
  check(
    renderedGroups.length === 2 &&
      !renderedGroups.some((group) => group.name === 'Dummy wholly paused group'),
    'Actual page props filtered by the shared rendering helper exclude wholly paused groups'
  )
  check(
    renderedGroups.find((group) => group.name === 'Dummy Mac group').monitors.length === 11,
    '69 Mac targets leave exactly 11 visible Mac targets'
  )
  const markup = responses[0].body.replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, '')
  check(
    !markup.includes('Dummy wholly paused group') && !markup.includes(monitors[0].name),
    'Initial markup contains no paused cards or groups'
  )
  check(
    !markup.includes('<canvas') && !markup.includes('data-history-timeline'),
    'Initial markup mounts no histories or charts'
  )
  reports.push({
    scenario: snapshot.complete ? 'expired-complete' : 'metadata-only',
    targets: 74,
    closed: 58,
    unknown: 16,
    responses: responses.map(({ body: _body, ...measurement }) => measurement),
  })
}
async function authChecks(mf) {
  const paths = [
    '/api/admin/config',
    '/api/admin/tokens',
    '/api/probes/config',
    '/api/probes/ingest',
    '/api/manage/status',
    '/api/manage/groups',
  ]
  const results = []
  for (const path of paths) {
    const response = await mf.dispatchFetch(
      origin + path,
      path.endsWith('/ingest')
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          }
        : {}
    )
    privateFree(await response.text())
    results.push({ path, status: response.status })
  }
  reports.push({ scenario: 'unauthenticated', responses: results })
  check(
    results.every((result) => result.status === 401),
    `Protected APIs must reject before requiring D1: ${results
      .map((result) => `${result.path}=${result.status}`)
      .join(', ')}`
  )
}

let mf, gateway
const browserRequests = { total: 0, history: 0 }
try {
  const metadata = fixtureSnapshot()
  mf = await instance(metadata)
  await publicChecks(mf, metadata)
  await mf.dispose()
  mf = undefined
  const expired = fixtureSnapshot(true)
  mf = await instance(expired)
  await publicChecks(mf, expired)
  await authChecks(mf)
  await mf.dispose()
  mf = undefined
  console.log(
    JSON.stringify(
      {
        passed: true,
        actualWorkerArtifact: true,
        artifactSha256: createHash('sha256')
          .update(await readFile(artifact))
          .digest('hex'),
        d1Bound: false,
        checks,
        reports,
      },
      null,
      2
    )
  )

  if (process.argv.includes('--preview')) {
    mf = await instance(fixtureSnapshot())
    gateway = createServer(async (incoming, outgoing) => {
      if (incoming.url === '/__fixture/stats') {
        outgoing.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
        outgoing.end(
          JSON.stringify({
            ...browserRequests,
            targets: 74,
            mac: 69,
            activeMac: 11,
            closed: 58,
            d1Bound: false,
          })
        )
        return
      }
      browserRequests.total++
      if (incoming.url.startsWith('/api/history?')) browserRequests.history++
      try {
        const chunks = []
        let size = 0
        for await (const chunk of incoming) {
          size += chunk.length
          if (size > 128 * 1024) throw new Error('Fixture request too large')
          chunks.push(chunk)
        }
        const headers = { ...incoming.headers, host: 'public-cache.test' }
        if (headers.origin === previewOrigin) headers.origin = origin
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
      }
    })
    await new Promise((resolve, reject) => {
      gateway.once('error', reject)
      gateway.listen(8796, '127.0.0.1', resolve)
    })
    console.log(
      `Dummy KV degradation preview: ${previewOrigin}/; request counters: /__fixture/stats`
    )
    await new Promise((resolve) => {
      process.once('SIGINT', resolve)
      process.once('SIGTERM', resolve)
    })
  }
} finally {
  gateway?.closeAllConnections()
  if (gateway) await new Promise((resolve) => gateway.close(resolve))
  await mf?.dispose()
}
