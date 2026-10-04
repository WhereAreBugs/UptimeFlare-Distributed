const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')

const diagnosticFilename = path.resolve(__dirname, '../worker/src/diagnostics.ts')
const diagnosticModule = new Module(diagnosticFilename, module)
diagnosticModule._compile(
  ts.transpileModule(fs.readFileSync(diagnosticFilename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
  diagnosticFilename
)
const settingsFilename = path.resolve(__dirname, 'monitor-settings.ts')
const settingsModule = new Module(settingsFilename, module)
settingsModule._compile(
  ts.transpileModule(fs.readFileSync(settingsFilename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
  settingsFilename
)
const probeStatusFilename = path.resolve(__dirname, 'probe-status.ts')
const probeStatusModule = new Module(probeStatusFilename, module)
probeStatusModule.require = (id) =>
  id === './monitor-settings' ? settingsModule.exports : require(id)
probeStatusModule._compile(
  ts.transpileModule(fs.readFileSync(probeStatusFilename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
  probeStatusFilename
)
const dashboardFilename = path.resolve(__dirname, 'dashboard-status.ts')
const dashboardModule = new Module(dashboardFilename, module)
dashboardModule.require = (id) =>
  id === './probe-status' ? probeStatusModule.exports : require(id)
dashboardModule._compile(
  ts.transpileModule(fs.readFileSync(dashboardFilename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
  dashboardFilename
)

function loadHandler(name, workerConfig, summaries, initialUpdate = 0, nativeIncident = null) {
  const calls = { nativeReads: 0, probeReads: 0 }
  class EmptyNativeState {
    constructor() {
      this.data = { lastUpdate: initialUpdate }
    }
    incidentLen() {
      return nativeIncident ? 1 : 0
    }
    latencyLen() {
      return nativeIncident ? 1 : 0
    }
    getIncident() {
      if (nativeIncident) return nativeIncident
      throw new Error('Native incident lookup must be guarded')
    }
    getLastLatency() {
      if (nativeIncident) return { ping: 0, loc: 'SIN', time: initialUpdate }
      throw new Error('Native latency lookup must be guarded')
    }
  }
  const mocks = {
    '@/util/maintenance': {
      getPresentationSettings: () => ({ page: {}, maintenances: workerConfig.maintenances ?? [] }),
      expandMaintenances: (plans) => plans,
    },
    '@/util/monitor-settings': settingsModule.exports,
    '@/util/dashboard-status': dashboardModule.exports,
    '@/worker/src/diagnostics': diagnosticModule.exports,
    '@/worker/src/settings': { getRuntimeConfig: async () => workerConfig },
    '@/worker/src/public-dashboard': {
      getPublicDashboard: async () => {
        const active = workerConfig.monitors.filter(
          (monitor) => monitor.probes?.length && !monitor.paused
        )
        if (active.length) calls.probeReads++
        if (workerConfig.monitors.some((monitor) => !monitor.paused && !monitor.probes?.length))
          calls.nativeReads++
        return {
          ...workerConfig,
          compactedStateStr: null,
          probeSummaries: Object.fromEntries(
            active.map((monitor) => [monitor.id, summaries[monitor.id]])
          ),
          maintenances: workerConfig.maintenances ?? [],
          configRevision: 0,
          snapshotAt: null,
          snapshotIncomplete: false,
          stale: false,
          source: 'd1',
        }
      },
    },
    '@/uptime.config': { workerConfig, maintenances: [] },
    '@/worker/src/probes': {
      getProbeIncidents: async () => {
        calls.probeReads++
        if (summaries.storageFailure) throw new Error('D1 SQL SELECT private-target-secret failed')
        return summaries.probes
      },
      getProbeSummaries: async () => {
        calls.probeReads++
        return summaries
      },
      getProbeDashboardSummaries: async (_env, monitors) => {
        const active = monitors.filter((monitor) => monitor.probes?.length && !monitor.paused)
        if (!active.length) return {}
        calls.probeReads++
        return Object.fromEntries(active.map((monitor) => [monitor.id, summaries[monitor.id]]))
      },
    },
    '@/worker/src/incident-history': {
      getNativeIncidents: async () => {
        calls.nativeReads++
        return summaries.native
      },
    },
    '@/worker/src/store': {
      getFromStore: async () => {
        calls.nativeReads++
        return null
      },
      getPublicNativeState: async (_env, monitors) => {
        if (monitors.some((monitor) => !monitor.paused && !monitor.probes?.length))
          calls.nativeReads++
        return null
      },
      CompactedMonitorStateWrapper: EmptyNativeState,
    },
  }
  const filename = path.resolve(__dirname, `../pages/api/${name}.ts`)
  const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText
  const loaded = new Module(filename, module)
  loaded.filename = filename
  loaded.paths = module.paths
  loaded.require = (id) => (id in mocks ? mocks[id] : require(id))
  loaded._compile(compiled, filename)
  return { handler: loaded.exports.default, calls }
}

const external = {
  id: 'host',
  name: 'Host',
  method: 'GET',
  target: 'https://private.test',
  probes: ['a'],
  headers: { Authorization: 'private-target-secret' },
  checkProxy: 'https://private-proxy.example/secret-path',
  icmpProxyURL: 'https://private-icmp.example/secret-path',
  checkProxyHeaders: { Authorization: 'private-proxy-secret' },
  certificateExpiryDays: 14,
}
const makeSummary = (status) => ({
  monitorId: 'host',
  historyLoaded: false,
  status,
  up: status === 'up' ? 1 : 0,
  down: status === 'down' ? 1 : 0,
  unknown: status === 'unknown' ? 1 : 0,
  total: 1,
  latest: status === 'unknown' ? null : 1000,
  probes: [],
})
const request = (url, method = 'GET') => new Request(`https://status.test${url}`, { method })

test('public data includes external results before the native scheduler has written any state', async () => {
  const { handler } = loadHandler('data', { monitors: [external] }, { host: makeSummary('up') })
  const response = await handler(request('/api/data'))
  assert.equal(response.status, 200)
  const value = await response.json()
  assert.deepEqual(
    [value.up, value.down, value.degraded, value.unknown, value.updatedAt],
    [1, 0, 0, 0, 1000]
  )
  assert.equal(value.monitors.host.status, 'up')
  assert.equal(value.monitors.host.up, true)
  assert.equal(value.monitors.host.reachableProbes, 1)
  assert.equal(JSON.stringify(value).includes('private-target-secret'), false)
  assert.equal(JSON.stringify(value).includes('private.test'), false)
  for (const secret of [
    'private-proxy.example',
    'private-icmp.example',
    'private-proxy-secret',
    'checkProxyHeaders',
    'certificateExpiryDays',
  ])
    assert.equal(JSON.stringify(value).includes(secret), false)
})

test('unknown external results and absent native records are not operational', async () => {
  const native = { ...external, id: 'native', probes: undefined }
  const { handler } = loadHandler(
    'data',
    { monitors: [external, native] },
    { host: makeSummary('unknown') }
  )
  const response = await handler(request('/api/data'))
  assert.equal(response.status, 200)
  const value = await response.json()
  assert.equal(value.unknown, 2)
  assert.equal(value.monitors.host.up, null)
  assert.equal(value.monitors.native.up, null)
})

test('public paused results are minimal closed stubs before maintenance without live counts or histories', async () => {
  const now = Math.floor(Date.now() / 1000)
  const monitors = [
    { ...external, paused: true },
    { ...external, id: 'maintained' },
    { ...external, id: 'healthy' },
    { ...external, id: 'unknown' },
  ]
  const pausedSummary = {
    ...makeSummary('up'),
    latest: now + 100,
    probes: [{ id: 'a', history: [] }],
  }
  const { handler } = loadHandler(
    'data',
    {
      monitors,
      maintenances: [
        {
          start: new Date((now - 10) * 1000).toISOString(),
          end: new Date((now + 10) * 1000).toISOString(),
          body: 'Maintenance',
          monitors: ['host', 'maintained'],
        },
      ],
    },
    {
      host: pausedSummary,
      maintained: makeSummary('down'),
      healthy: makeSummary('up'),
      unknown: makeSummary('unknown'),
    }
  )
  const response = await handler(request('/api/data'))
  assert.equal(response.status, 200)
  const value = await response.json()
  assert.deepEqual(
    [value.healthy, value.closed, value.maintenance, value.abnormal, value.total],
    [1, 1, 1, 1, 4]
  )
  assert.equal(value.monitors.host.status, 'paused')
  assert.equal(value.monitors.host.category, 'closed')
  assert.equal(value.monitors.host.up, null)
  assert.equal(value.monitors.host.reachableProbes, null)
  assert.equal(value.monitors.host.unreachableProbes, null)
  assert.equal(value.monitors.host.unknownProbes, null)
  assert.equal(value.updatedAt, 1000, 'a paused target does not update live freshness')
  assert.equal(value.monitors.host.historyLoaded, false)
  assert.equal(value.monitors.host.probes, undefined)
  assert.equal(value.monitors.host.dailyHistory, undefined)
})

test('an entirely paused native installation can return closed before its first state record', async () => {
  const { handler } = loadHandler(
    'data',
    { monitors: [{ ...external, probes: undefined, paused: true }] },
    {}
  )
  const response = await handler(request('/api/data'))
  assert.equal(response.status, 200)
  const value = await response.json()
  assert.equal(value.closed, 1)
  assert.equal(value.abnormal, 0)
  assert.equal(value.monitors.host.up, null)
})

test('public dashboard returns explicitly unloaded history and skips native reads for all-external targets', async () => {
  const { handler, calls } = loadHandler(
    'data',
    { monitors: [external] },
    { host: makeSummary('up') }
  )
  const value = await (await handler(request('/api/data'))).json()
  assert.equal(value.monitors.host.historyLoaded, false)
  assert.deepEqual(calls, { nativeReads: 0, probeReads: 1 })
  const paused = loadHandler('data', { monitors: [{ ...external, paused: true }] }, {})
  await paused.handler(request('/api/data'))
  assert.deepEqual(paused.calls, { nativeReads: 0, probeReads: 0 })
})

test('native public errors expose phase fields and preserve historical message text', async () => {
  const native = { ...external, probes: undefined }
  for (const [message, stage, code] of [
    ['[http/status] Expected codes: 2xx, Got: 503', 'http', 'status'],
    ['A historical error without reliable phase evidence', 'unknown', 'unknown'],
  ]) {
    const incident = { start: [1000], end: null, error: [message] }
    const { handler } = loadHandler(
      'data',
      { monitors: [native] },
      {},
      Math.floor(Date.now() / 1000),
      incident
    )
    const value = await (await handler(request('/api/data'))).json()
    assert.equal(value.monitors.host.stage, stage)
    assert.equal(value.monitors.host.code, code)
    assert.equal(value.monitors.host.message, message)
    assert.equal(value.monitors.host.up, false)
  }
})

test('data preflight and unsupported methods do not read the database', async () => {
  const { handler, calls } = loadHandler('data', { monitors: [external] }, {})
  assert.equal((await handler(request('/api/data', 'OPTIONS'))).status, 204)
  assert.equal((await handler(request('/api/data', 'POST'))).status, 405)
  assert.deepEqual(calls, { nativeReads: 0, probeReads: 0 })
})

test('public results never expose notification template configuration or credentials', async () => {
  const { handler } = loadHandler(
    'data',
    {
      monitors: [{ ...external, notificationTemplateId: 'private-template' }],
      notificationTemplates: [
        {
          id: 'private-template',
          name: 'Private',
          type: 'webhook',
          webhook: {
            url: 'https://private-hook.example/secret-path',
            headers: { Authorization: 'private-notification-secret' },
          },
        },
      ],
    },
    { host: makeSummary('up') }
  )
  const response = await handler(request('/api/data'))
  const body = await response.text()
  assert.equal(response.status, 200)
  for (const secret of ['private-template', 'private-hook.example', 'private-notification-secret'])
    assert.equal(body.includes(secret), false)
})

test('probe badges distinguish unknown, mixed and failed results without reading native incidents', async () => {
  for (const [status, message, color] of [
    ['up', 'UP', 'brightgreen'],
    ['down', 'DOWN', 'red'],
    ['degraded', 'PARTIAL', 'orange'],
    ['unknown', 'UNKNOWN', 'lightgrey'],
  ]) {
    const { handler, calls } = loadHandler(
      'badge',
      { monitors: [external] },
      { host: makeSummary(status) }
    )
    const response = await handler(request('/api/badge?id=host'))
    assert.equal(response.status, 200)
    const value = await response.json()
    assert.equal(value.message, message)
    assert.equal(value.color, color)
    assert.equal(calls.nativeReads, 0)
  }
})

test('unconfigured and empty native badges avoid out-of-bounds incident lookups', async () => {
  const native = { ...external, probes: undefined }
  const { handler, calls } = loadHandler('badge', { monitors: [native] }, {})
  assert.equal((await handler(request('/api/badge?id=unconfigured'))).status, 404)
  assert.equal(calls.nativeReads, 0)
  const value = await (await handler(request('/api/badge?id=host'))).json()
  assert.equal(value.message, 'UNKNOWN')
  assert.equal(value.color, 'lightgrey')
})

test('native data and badges use the target interval for freshness', async (t) => {
  const now = 1_800_000
  t.mock.method(Date, 'now', () => now * 1000)
  const incident = { start: [now - 500], end: now - 500, error: [] }
  for (const [intervalSeconds, age, expectedStatus, expectedBadge] of [
    [60, 120, 'up', 'UP'],
    [60, 121, 'unknown', 'UNKNOWN'],
    [600, 121, 'up', 'UP'],
    [undefined, 601, 'unknown', 'UNKNOWN'],
  ]) {
    const monitor = { ...external, probes: undefined, intervalSeconds }
    const data = loadHandler('data', { monitors: [monitor] }, {}, now - age, incident)
    const value = await (await data.handler(request('/api/data'))).json()
    assert.equal(value.monitors.host.status, expectedStatus)
    assert.equal(value.updatedAt, now - age)
    const badge = loadHandler('badge', { monitors: [monitor] }, {}, now - age, incident)
    const badgeValue = await (await badge.handler(request('/api/badge?id=host'))).json()
    assert.equal(badgeValue.message, expectedBadge)
  }
})

test('public incident pages use bounded public result shapes and protect private configuration', async () => {
  const page = {
    failures: [
      {
        time: 1000,
        monitorId: 'host',
        monitorName: 'Host',
        probeId: 'a',
        probeName: 'Tokyo',
        stage: 'tcp',
        code: 'refused',
        message: 'TCP connection was refused',
      },
    ],
    nextCursor: null,
    from: 0,
    to: 2000,
  }
  const { handler } = loadHandler(
    'incidents',
    { monitors: [external] },
    { probes: page, native: { incidents: [], nextCursor: null, from: 0, to: 2000 } }
  )
  const response = await handler(request('/api/incidents?kind=all&from=0&to=2000'))
  assert.equal(response.status, 200)
  const body = await response.text()
  assert.equal(JSON.parse(body).probes.failures[0].monitorName, 'Host')
  for (const secret of [
    'private.test',
    'private-target-secret',
    'private-proxy.example',
    'private-icmp.example',
    'private-proxy-secret',
    'checkProxyHeaders',
  ])
    assert.equal(body.includes(secret), false)
})

test('incident API rejects invalid requests before reads and masks storage errors', async () => {
  const { handler, calls } = loadHandler(
    'incidents',
    { monitors: [external] },
    { storageFailure: true }
  )
  assert.equal((await handler(request('/api/incidents', 'POST'))).status, 405)
  assert.equal((await handler(request('/api/incidents?kind=sql'))).status, 400)
  assert.equal((await handler(request('/api/incidents?from=NaN'))).status, 400)
  assert.deepEqual(calls, { nativeReads: 0, probeReads: 0 })
  const response = await handler(request('/api/incidents?kind=probes'))
  assert.equal(response.status, 503)
  const body = await response.text()
  assert.equal(body.includes('SELECT'), false)
  assert.equal(body.includes('private-target-secret'), false)
})
