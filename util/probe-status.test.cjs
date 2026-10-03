const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')

// Use the repository's TypeScript compiler; no test-only runtime dependency is needed.
const filename = path.join(__dirname, 'probe-status.ts')
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText
const loaded = new Module(filename, module)
loaded.filename = filename
loaded.paths = module.paths
loaded._compile(compiled, filename)
const { aggregateStatus, refreshProbeSummary, getMonitorStatus, summarizeMonitors } = loaded.exports

const emptyState = { lastUpdate: 0, overallUp: 0, overallDown: 0, incident: {}, latency: {} }
const native = { id: 'native', name: 'Native', method: 'GET', target: 'https://example.test' }
const external = { ...native, id: 'external', name: 'External', probes: ['a', 'b'] }
const makeProbe = (id, status, latest, stale = false) => ({
  id,
  name: id,
  status,
  latest,
  stale,
  latencyMs: 8,
  checks: 1,
  failures: status === 'down' ? 1 : 0,
  avgLatencyMs: 8,
  history: [],
  recentFailures: [],
  failureStages: {},
})
const makeSummary = (probes) => ({
  monitorId: 'external',
  status: 'up',
  up: probes.length,
  down: 0,
  unknown: 0,
  total: probes.length,
  latest: Math.max(...probes.map((probe) => probe.latest ?? 0)),
  probes,
})

test('aggregation distinguishes all failures, partial coverage, and no evidence', () => {
  for (const [up, down, unknown, expected] of [
    [0, 0, 0, 'unknown'],
    [2, 0, 0, 'up'],
    [0, 2, 0, 'down'],
    [0, 0, 2, 'unknown'],
    [1, 1, 0, 'degraded'],
    [1, 0, 1, 'degraded'],
    [0, 1, 1, 'degraded'],
  ])
    assert.equal(aggregateStatus(up, down, unknown), expected)
})

test('stale results stop counting as reachability evidence while a page remains open', () => {
  const summary = makeSummary([makeProbe('a', 'up', 1000), makeProbe('b', 'down', 1800)])
  assert.equal(refreshProbeSummary(summary, 1900).status, 'degraded')
  const aged = refreshProbeSummary(summary, 1901)
  assert.equal(aged.probes[0].status, 'unknown')
  assert.equal(aged.probes[0].stale, true)
  assert.deepEqual([aged.up, aged.down, aged.unknown], [0, 1, 1])
  assert.equal(aged.status, 'degraded')
  assert.equal(summary.probes[0].status, 'up', 'the serialized input remains unchanged')
  assert.equal(refreshProbeSummary(summary, 2801).status, 'unknown')
})

test('a server-declared stale result remains unknown even if the browser clock is behind', () => {
  const summary = makeSummary([makeProbe('a', 'up', 1000, true)])
  assert.equal(refreshProbeSummary(summary, 999).status, 'unknown')
})

test('external status does not depend on native monitor state existing', () => {
  const summaries = {
    external: makeSummary([makeProbe('a', 'up', 1000), makeProbe('b', 'up', 1000)]),
  }
  assert.equal(getMonitorStatus(external, emptyState, summaries, 1100), 'up')
  assert.equal(getMonitorStatus(external, emptyState, {}, 1100), 'unknown')
  assert.equal(getMonitorStatus(native, emptyState, {}, 1100), 'unknown')
})

test('overall counts combine native and external monitors without treating missing data as green', () => {
  const state = {
    ...emptyState,
    lastUpdate: 1100,
    latency: { native: [{ time: 1100, ping: 12, loc: 'SIN' }] },
    incident: { native: [{ start: [1000], end: null, error: ['Connection refused'] }] },
  }
  const summaries = {
    external: makeSummary([makeProbe('a', 'up', 1000), makeProbe('b', 'unknown', null)]),
  }
  const missing = { ...native, id: 'missing' }
  assert.deepEqual(summarizeMonitors([native, external, missing], state, summaries, 1100), {
    up: 0,
    down: 1,
    degraded: 1,
    unknown: 1,
    total: 3,
    lastUpdate: 1100,
  })
})
