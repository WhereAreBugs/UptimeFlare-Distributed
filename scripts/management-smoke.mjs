#!/usr/bin/env node
/** Exercise the actual unified Worker artifact, with disposable D1 and dummy credentials only. */
import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { gzipSync } from 'node:zlib'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const staticRoot = join(root, 'out')
const artifact = join(root, '.deployment/unified-worker/index.js')
const { Miniflare } = await import(
  pathToFileURL(join(root, 'worker/node_modules/miniflare/dist/src/index.js'))
)
const origin = 'https://preview.test'
const probeToken = 'pages-smoke-independent-fixture-token-123456'
const password = 'pages-smoke-admin-password-123456789'
const marker = 'PRIVATE_CONFIGURATION_MARKER'
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
    ['worker/src', 'pages', 'types', 'util', 'components', 'locales'].map((directory) =>
      files(join(root, directory))
    )
  )
)
  .flat()
  .filter((path) => /\.(?:ts|tsx)$/.test(path))
  .concat(join(root, 'compat/middleware.ts'), join(root, 'uptime.config.ts'))
assert.ok(
  (await Promise.all(sources.map((path) => stat(path)))).every(
    (value) => value.mtimeMs <= artifactTime
  ),
  'Build a fresh unified Worker artifact before running the management smoke test'
)
const mf = new Miniflare({
  modules: (await files(dirname(artifact)))
    .filter((path) => path.endsWith('.js'))
    .sort((a, b) => (a === artifact ? -1 : b === artifact ? 1 : a.localeCompare(b)))
    .map((path) => ({ type: 'ESModule', path })),
  modulesRoot: dirname(artifact),
  compatibilityDate: '2025-04-02',
  compatibilityFlags: ['nodejs_compat'],
  cf: { country: 'SG', city: 'Singapore', asn: 64512 },
  d1Databases: ['UPTIMEFLARE_D1'],
  bindings: {
    PROBE_TOKENS: JSON.stringify({ p1: probeToken }),
    ADMIN_PASSWORD: password,
    ADMIN_SESSION_SECRET: 'pages-smoke-session-secret-at-least-32-characters',
  },
  serviceBindings: {
    ASSETS: async (request) => {
      const pathname = decodeURIComponent(new URL(request.url).pathname)
      const path = resolve(staticRoot, '.' + pathname)
      if (!path.startsWith(staticRoot + '/')) return new Response('Not found', { status: 404 })
      try {
        let bytes
        try {
          bytes = await readFile(path)
        } catch {
          bytes = await readFile(path + '.html')
        }
        const extension = pathname.split('/').pop()
        const type = path.endsWith('.js')
          ? 'application/javascript'
          : path.endsWith('.css')
          ? 'text/css'
          : path.endsWith('.svg')
          ? 'image/svg+xml'
          : path.endsWith('.png')
          ? 'image/png'
          : path.endsWith('.webp')
          ? 'image/webp'
          : !extension.includes('.') || path.endsWith('.html')
          ? 'text/html'
          : 'application/octet-stream'
        return new Response(bytes, { headers: { 'Content-Type': type } })
      } catch {
        return new Response('Not found', { status: 404 })
      }
    },
  },
})
let gateway
try {
  const db = await mf.getD1Database('UPTIMEFLARE_D1')
  for (const sql of (await readFile(join(root, 'init.sql'), 'utf8'))
    .split(';')
    .filter((sql) => sql.trim()))
    await db.prepare(sql).run()
  const now = Math.floor(Date.now() / 1000)
  const config = {
    probes: [{ id: 'p1', name: 'Tokyo · AS61112' }, { id: 'cloudflare' }],
    monitors: ['a1', 'a2', 'b1', 'u1'].map((id, index) => ({
      id,
      name: ['API website', 'Application website', 'Database website', 'Ungrouped website'][index],
      method: 'GET',
      target: `https://${marker.toLowerCase()}.test/${id}`,
      probes: id === 'a1' ? ['p1', 'cloudflare'] : ['p1'],
      intervalSeconds: 300,
      timeout: 5000,
      headers: { Authorization: marker },
      body: marker,
      checkProxyHeaders: { Authorization: marker },
      notificationTemplateId: 'notice',
    })),
    notificationTemplates: [
      {
        id: 'notice',
        name: 'Private webhook',
        type: 'webhook',
        webhook: {
          url: `https://${marker.toLowerCase()}.test/webhook`,
          method: 'POST',
          payloadType: 'json',
          payload: { text: marker },
          headers: { Authorization: marker },
          timeout: 5000,
        },
      },
    ],
    page: { title: '管理 Token · 本地验收', group: { A: ['a1', 'a2'], B: ['b1'] }, links: [] },
    maintenances: [],
    notification: { timeZone: 'Asia/Singapore', gracePeriod: 1 },
  }
  await db
    .prepare('INSERT INTO admin_config(id,revision,value,updated_at) VALUES(1,1,?,?)')
    .bind(JSON.stringify(config), now)
    .run()
  let checks = 0
  let cookie = ''
  // Never include response bodies in assertion errors: creation responses contain credentials.
  async function call(
    path,
    expected,
    { method = 'GET', credential, admin = false, data, extra = {} } = {}
  ) {
    const headers = {
      ...(admin && cookie ? { Cookie: cookie } : {}),
      ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      ...(method !== 'GET' && admin ? { Origin: origin } : {}),
      ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...extra,
    }
    const response = await mf.dispatchFetch(origin + path, {
      method,
      headers,
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    })
    assert.equal(response.status, expected, `${method} ${path}: unexpected HTTP status`)
    checks++
    return response
  }
  async function json(path, expected = 200, options) {
    return (await call(path, expected, options)).json()
  }
  const login = await call('/api/admin/login', 200, {
    method: 'POST',
    admin: true,
    data: { password },
  })
  cookie = login.headers.get('Set-Cookie').split(';')[0]
  await call('/api/admin/tokens', 401)
  const rawBefore = await db.prepare('SELECT revision,value FROM admin_config WHERE id=1').first()
  await call('/api/probes/config', 200, { credential: probeToken })
  const beforeAdmin = await db.prepare('SELECT revision,value FROM admin_config WHERE id=1').first()
  assert.deepEqual(beforeAdmin, rawBefore, 'Probe reads must not initialize identities')
  const [initial, parallel] = await Promise.all([
    json('/api/admin/config', 200, { admin: true }),
    json('/api/admin/config', 200, { admin: true }),
  ])
  assert.deepEqual(
    initial.groupIds,
    parallel.groupIds,
    'Concurrent initialization must retain one identity set'
  )
  assert.equal(initial.revision, 1, 'Metadata initialization must preserve settings revision')
  const aId = initial.groupIds.A,
    bId = initial.groupIds.B
  assert.ok(aId && bId && aId !== bId, 'Groups must have distinct generated identities')
  const seeded = await mf.dispatchFetch(origin + '/api/probes/ingest', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${probeToken}`,
      'Content-Type': 'application/json',
      'Content-Encoding': 'gzip',
    },
    body: gzipSync(
      JSON.stringify({
        version: 1,
        batch_id: 'a'.repeat(64),
        results: [
          { monitor_id: 'a1', time: now, up: true, latency_ms: 14 },
          {
            monitor_id: 'a2',
            time: now,
            up: false,
            latency_ms: 9,
            stage: 'tcp',
            code: 'tcp_refused',
            message: marker,
          },
          { monitor_id: 'b1', time: now, up: true, latency_ms: 11 },
        ],
      })
    ),
  })
  assert.equal(seeded.status, 200, 'Real compressed probe fixture ingestion')
  async function create(name, permissions = ['query', 'control'], expiresAt = null) {
    return json('/api/admin/tokens', 201, {
      admin: true,
      method: 'POST',
      data: { name, groupIds: [aId], permissions, expiresAt },
    })
  }
  const both = await create('Automation'),
    query = await create('Query only', ['query']),
    control = await create('Control only', ['control'])
  assert.ok(/^ufm_[a-f0-9]{64}$/.test(both.token), 'Opaque management credential format')
  const list = await json('/api/admin/tokens', 200, { admin: true })
  assert.equal(list.tokens.length, 3)
  assert.ok(
    [both.token, query.token, control.token, 'token_hash'].every(
      (value) => !JSON.stringify(list).includes(value)
    ),
    'Token listings must not disclose secrets'
  )
  const rows = await db.prepare('SELECT token_hash FROM management_tokens').all()
  assert.ok(
    rows.results.every((row) => !JSON.stringify(list).includes(row.token_hash)),
    'Token lists must never expose stored hash values'
  )
  assert.ok(
    rows.results.every(
      (row) => /^[a-f0-9]{64}$/.test(row.token_hash) && row.token_hash !== both.token
    ),
    'Only hashes may be persisted'
  )
  const scoped = await json('/api/manage/groups', 200, { credential: both.token })
  assert.deepEqual(
    scoped.groups.map((group) => [
      group.id,
      group.name,
      group.monitors.map((monitor) => monitor.id),
    ]),
    [[aId, 'A', ['a1', 'a2']]]
  )
  const status = await json('/api/manage/status', 200, { credential: both.token })
  assert.deepEqual(
    status.monitors.map((monitor) => [monitor.id, monitor.status]),
    [
      ['a1', 'up'],
      ['a2', 'down'],
    ],
    'Offline probe must not degrade healthy status'
  )
  const safeFields = [
    'id',
    'name',
    'paused',
    'status',
    'up',
    'latest',
    'latencyMs',
    'reachableProbes',
    'unreachableProbes',
    'unknownProbes',
  ].sort()
  assert.ok(
    status.monitors.every(
      (monitor) => JSON.stringify(Object.keys(monitor).sort()) === JSON.stringify(safeFields)
    ),
    'Status fields must follow explicit allowlist'
  )
  assert.ok(
    !JSON.stringify(status).includes(marker) &&
      !JSON.stringify(status).includes(marker.toLowerCase()),
    'Private target and failure details must remain hidden'
  )
  await call(`/api/manage/groups/${aId}/status`, 200, { credential: query.token })
  await call('/api/manage/monitors/a1/status', 200, { credential: query.token })
  await call('/api/manage/groups', 200, { credential: control.token })
  await call('/api/manage/status', 403, { credential: control.token })
  await call(`/api/manage/groups/${aId}/disable`, 403, { method: 'POST', credential: query.token })
  for (const path of [
    `/api/manage/groups/${bId}/status`,
    '/api/manage/monitors/b1/status',
    '/api/manage/monitors/u1/status',
  ])
    await call(path, 403, { credential: both.token })
  for (const id of ['b1', 'u1', 'does-not-exist'])
    await call(`/api/manage/monitors/${id}/disable`, 403, {
      method: 'POST',
      credential: both.token,
    })
  await call('/api/manage/status', 401, { credential: probeToken })
  await call('/api/manage/status', 401, { admin: true })
  await call('/api/manage/status', 401, { credential: 'invalid', admin: true })
  await call('/api/admin/config', 401, { credential: both.token, admin: true })
  await call('/api/admin/tokens', 401, { credential: both.token, admin: true })
  await call('/api/probes/config', 401, { credential: both.token })
  await call('/api/probes/ingest', 401, { method: 'POST', credential: both.token, data: {} })
  await call('/api/manage/status?token=unused', 400, { credential: both.token })
  await call('/api/manage/status', 403, {
    credential: both.token,
    extra: { Origin: 'https://other.test' },
  })
  await call('/api/manage/status', 405, { credential: both.token, method: 'OPTIONS' })
  await call(`/api/manage/groups/${aId}/disable`, 400, {
    credential: both.token,
    method: 'POST',
    data: { monitors: ['b1'] },
  })
  await call('/api/admin/tokens', 403, {
    admin: true,
    method: 'POST',
    data: {},
    extra: { Origin: 'https://other.test' },
  })
  const baseline = await json('/api/admin/config', 200, { admin: true })
  await call(`/api/manage/groups/${aId}/disable`, 200, { credential: both.token, method: 'POST' })
  let paused = await json('/api/admin/config', 200, { admin: true })
  assert.deepEqual(
    paused.monitors.filter((monitor) => monitor.paused).map((monitor) => monitor.id),
    ['a1', 'a2']
  )
  for (const monitor of paused.monitors) {
    const { paused: _paused, ...other } = monitor
    assert.deepEqual(
      other,
      baseline.monitors.find((item) => item.id === monitor.id),
      'Control may only modify paused flags'
    )
  }
  assert.deepEqual(
    paused.notificationTemplates,
    baseline.notificationTemplates,
    'Control must preserve private webhook configuration'
  )
  assert.deepEqual(paused.groupIds, baseline.groupIds, 'Control must preserve group identity')
  const pausedStates = await json('/api/manage/status', 200, { credential: query.token })
  assert.ok(
    pausedStates.monitors.every(
      (monitor) => monitor.status === 'paused' && monitor.latencyMs === null
    )
  )
  const assignments = await json('/api/probes/config', 200, { credential: probeToken })
  assert.ok(
    !assignments.monitors.some((monitor) => ['a1', 'a2'].includes(monitor.id)),
    'Paused targets must leave executable probe configuration'
  )
  const pausedDisplay = assignments.display_monitors.filter((monitor) =>
    ['a1', 'a2'].includes(monitor.id)
  )
  assert.equal(pausedDisplay.length, 2, 'Local dashboard retains paused assignments')
  assert.ok(pausedDisplay.every((monitor) => monitor.paused))
  assert.ok(pausedDisplay.every((monitor) =>
    !['target', 'headers', 'body', 'checkProxyHeaders'].some((key) => key in monitor)
  ), 'Display metadata must not contain target request secrets')
  await call('/api/manage/monitors/a1/enable', 200, {
    credential: control.token,
    method: 'POST',
    data: {},
  })
  await call(`/api/manage/groups/${aId}/enable`, 200, { credential: both.token, method: 'POST' })
  await call(`/api/manage/groups/${aId}/enable`, 200, { credential: both.token, method: 'POST' })
  const samples = await db.prepare('SELECT COUNT(*) AS count FROM probe_samples').first()
  assert.equal(samples.count, 3, 'Pausing must retain historical samples')
  const expiring = await create('Expires', ['query'], now + 3600)
  await db
    .prepare('UPDATE management_tokens SET expires_at=? WHERE id=?')
    .bind(now - 1, expiring.entry.id)
    .run()
  await call('/api/manage/status', 401, { credential: expiring.token })
  await call(`/api/admin/tokens/${query.entry.id}`, 200, { admin: true, method: 'DELETE' })
  await call('/api/manage/status', 401, { credential: query.token })
  async function save(change, expected = 200) {
    const current = await json('/api/admin/config', 200, { admin: true })
    return json('/api/admin/config', expected, {
      admin: true,
      method: 'PUT',
      data: change(current),
    })
  }
  await save((current) => ({
    ...current,
    page: { ...current.page, group: { Renamed: current.page.group.A, B: ['b1'] } },
    groupIds: { Renamed: aId, B: bId },
    groupRenames: { A: 'Renamed' },
  }))
  assert.equal(
    (await json('/api/manage/groups', 200, { credential: both.token })).groups[0].name,
    'Renamed'
  )
  await call(`/api/manage/groups/${aId}/status`, 200, { credential: both.token })
  await save((current) => ({
    ...current,
    page: { ...current.page, group: { Renamed: ['a1'], B: ['b1', 'a2'] } },
  }))
  await call('/api/manage/monitors/a2/disable', 403, { credential: both.token, method: 'POST' })
  await save((current) => ({ ...current, groupIds: { B: bId } })) // same-name delete/recreate in a single UI save
  const recreated = await json('/api/admin/config', 200, { admin: true })
  assert.notEqual(recreated.groupIds.Renamed, aId, 'Same-name recreation must get a fresh identity')
  assert.deepEqual((await json('/api/manage/groups', 200, { credential: both.token })).groups, [])
  await call(`/api/manage/groups/${aId}/disable`, 403, { credential: both.token, method: 'POST' })
  await call('/api/manage/monitors/a1/disable', 403, { credential: both.token, method: 'POST' })
  await save((current) => ({ ...current, groupIds: { ...current.groupIds, Renamed: aId } }), 400)
  await save((current) => ({ ...current, groupIds: { ...current.groupIds, Renamed: bId } }), 400)
  await save((current) => {
    const { groupIds: _groupIds, ...legacy } = current
    return legacy
  }, 409)
  await call('/api/admin/config', 409, {
    admin: true,
    method: 'PUT',
    data: { ...recreated, revision: recreated.revision - 1 },
  })
  for (const token of [both, control])
    await call(`/api/admin/tokens/${token.entry.id}`, 200, { admin: true, method: 'DELETE' })
  await call('/api/manage/status', 401, { credential: both.token })
  const response = await call('/api/manage/status', 401)
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.ok(!response.headers.has('Access-Control-Allow-Origin'))
  console.log(
    `Management Worker artifact smoke passed (${checks} HTTP assertions plus D1 and privacy checks).`
  )

  if (process.argv.includes('--preview')) {
    await db.prepare('DELETE FROM management_tokens').run()
    await db
      .prepare('UPDATE admin_config SET revision=1,value=? WHERE id=1')
      .bind(JSON.stringify(config))
      .run()
    gateway = createServer(async (request, outgoing) => {
      try {
        const chunks = []
        for await (const chunk of request) chunks.push(chunk)
        const headers = { ...request.headers, host: 'preview.test' }
        if (headers.origin === 'http://127.0.0.1:8793') headers.origin = origin
        const bytes = Buffer.concat(chunks)
        const result = await mf.dispatchFetch(origin + request.url, {
          method: request.method,
          headers,
          ...(bytes.length ? { body: bytes } : {}),
        })
        outgoing.writeHead(result.status, Object.fromEntries(result.headers))
        outgoing.end(Buffer.from(await result.arrayBuffer()))
      } catch {
        outgoing.writeHead(500)
        outgoing.end('Preview gateway failed')
      }
    })
    await new Promise((resolve) => gateway.listen(8793, '127.0.0.1', resolve))
    console.log(
      'Dummy fixture preview: http://127.0.0.1:8793/admin; password: pages-smoke-admin-password-123456789'
    )
    process.on('SIGTERM', () => {
      gateway.close()
      mf.dispose().finally(() => process.exit(0))
    })
    await new Promise(() => {})
  }
} finally {
  gateway?.close()
  await mf.dispose()
}
