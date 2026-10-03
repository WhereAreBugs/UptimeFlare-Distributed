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
    '@/worker/src/diagnostics': diagnosticModule.exports,
    '@/uptime.config': { workerConfig, maintenances: [] },
    '@/worker/src/probes': {
      getProbeSummaries: async () => {
        calls.probeReads++
        return summaries
      },
    },
    '@/worker/src/store': {
      getFromStore: async () => {
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
}
const makeSummary = (status) => ({
  monitorId: 'host',
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

test('native public errors expose phase fields and preserve historical message text', async () => {
  const native = { ...external, probes: undefined }
  for (const [message, stage, code] of [
    ['[http/status] Expected codes: 2xx, Got: 503', 'http', 'status'],
    ['A historical error without reliable phase evidence', 'unknown', 'unknown'],
  ]) {
    const incident = { start: [1000], end: null, error: [message] }
    const { handler } = loadHandler('data', { monitors: [native] }, {}, 1100, incident)
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
