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
const settingsFilename = path.join(__dirname, 'monitor-settings.ts')
const settingsModule = new Module(settingsFilename, module)
settingsModule._compile(
  ts.transpileModule(fs.readFileSync(settingsFilename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText,
  settingsFilename
)
loaded.require = (id) => (id === './monitor-settings' ? settingsModule.exports : require(id))
loaded._compile(compiled, filename)
const {
  aggregateStatus,
  refreshProbeSummary,
  getMonitorStatus,
  summarizeMonitors,
  summarizeProbeHistory,
} = loaded.exports

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

test('aggregation ignores unknown probes while preserving mixed results and no evidence', () => {
  for (const [up, down, unknown, expected] of [
    [0, 0, 0, 'unknown'],
    [2, 0, 0, 'up'],
    [0, 2, 0, 'down'],
    [0, 0, 2, 'unknown'],
    [1, 1, 0, 'degraded'],
    [1, 0, 1, 'up'],
    [0, 1, 1, 'down'],
    [1, 1, 1, 'degraded'],
  ])
    assert.equal(aggregateStatus(up, down, unknown), expected)
  assert.equal(aggregateStatus(1, 0, 1, 1), 'degraded')
  assert.equal(aggregateStatus(0, 0, 1, 1), 'degraded')
})

test('stale results stop counting as reachability evidence while a page remains open', () => {
  const summary = makeSummary([makeProbe('a', 'up', 1000), makeProbe('b', 'down', 1500)])
  assert.equal(refreshProbeSummary(summary, 1600).status, 'degraded')
  const aged = refreshProbeSummary(summary, 1601)
  assert.equal(aged.probes[0].status, 'unknown')
  assert.equal(aged.probes[0].stale, true)
  assert.deepEqual([aged.up, aged.down, aged.unknown], [0, 1, 1])
  assert.equal(aged.status, 'down')
  assert.equal(summary.probes[0].status, 'up', 'the serialized input remains unchanged')
  assert.equal(refreshProbeSummary(summary, 2101).status, 'unknown')
})

test('a server-declared stale result remains unknown even if the browser clock is behind', () => {
  const summary = makeSummary([makeProbe('a', 'up', 1000, true)])
  assert.equal(refreshProbeSummary(summary, 999).status, 'unknown')
})

test('each target ages results at twice its own interval, including while a page remains open', () => {
  const summary = makeSummary([makeProbe('a', 'up', 1000)])
  const fast = { ...external, intervalSeconds: 60 }
  const slow = { ...external, intervalSeconds: 1800 }
  assert.equal(refreshProbeSummary(summary, 1120, fast).status, 'up')
  assert.equal(refreshProbeSummary(summary, 1121, fast).status, 'unknown')
  assert.equal(refreshProbeSummary(summary, 4600, slow).status, 'up')
  assert.equal(refreshProbeSummary(summary, 4601, slow).status, 'unknown')
  assert.equal(getMonitorStatus(fast, emptyState, { external: summary }, 1121), 'unknown')
  assert.equal(getMonitorStatus(slow, emptyState, { external: summary }, 1121), 'up')
})

test('newer native targets do not keep another target fresh', () => {
  const state = {
    ...emptyState,
    lastUpdate: 1700,
    latency: { native: [{ time: 1000, ping: 12, loc: 'SIN' }] },
    incident: { native: [{ start: [1000], end: 1000, error: [] }] },
  }
  assert.equal(getMonitorStatus(native, state, {}, 1600), 'up')
  assert.equal(getMonitorStatus(native, state, {}, 1601), 'unknown')
  assert.equal(getMonitorStatus({ ...native, intervalSeconds: 600 }, state, {}, 1700), 'up')
})

test('external status does not depend on native monitor state existing', () => {
  const summaries = {
    external: makeSummary([makeProbe('a', 'up', 1000), makeProbe('b', 'up', 1000)]),
  }
  assert.equal(getMonitorStatus(external, emptyState, summaries, 1100), 'up')
  assert.equal(getMonitorStatus(external, emptyState, {}, 1100), 'unknown')
  assert.equal(getMonitorStatus(native, emptyState, {}, 1100), 'unknown')
})

test('overall counts retain unknown monitors while ignoring missing probe results in reachability', () => {
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
    up: 1,
    down: 1,
    degraded: 0,
    unknown: 1,
    total: 3,
    lastUpdate: 1100,
  })
})

test('history colors consider only reporting probes despite unequal check intervals', () => {
  const now = 1_800_123
  const time = 1_800_000
  const history = (checks, failures, avgLatencyMs = 20) => ({
    history: [{ time, checks, failures, avgLatencyMs }],
  })
  const latest = (probes) => summarizeProbeHistory(probes, now).at(-1)
  assert.equal(latest([history(30, 0), history(5, 0)]).status, 'up')
  assert.equal(latest([history(30, 30), history(5, 5)]).status, 'down')
  assert.equal(latest([history(30, 0), history(5, 5)]).status, 'degraded')
  assert.equal(latest([history(30, 1), history(5, 0)]).status, 'degraded')
  assert.equal(latest([history(30, 0), { history: [] }]).status, 'up')
  assert.equal(latest([history(30, 30), { history: [] }]).status, 'down')
  assert.equal(latest([history(30, 1), { history: [] }]).status, 'degraded')
  assert.equal(latest([{ history: [] }, history(0, 0)]).status, 'unknown')
  assert.equal(latest([]).status, 'unknown')
  assert.equal(latest([history(30, 1)]).status, 'degraded')
})

test('history aggregates counts and weighted latency into aligned five-minute intervals', () => {
  const time = 1_800_000
  const buckets = summarizeProbeHistory(
    [
      { history: [{ time, checks: 30, failures: 0, avgLatencyMs: 20 }] },
      { history: [{ time, checks: 5, failures: 1, avgLatencyMs: 60 }] },
      { history: [{ time: time - 300, checks: 1, failures: 0, avgLatencyMs: null }] },
    ],
    time + 299
  )
  assert.equal(buckets.length, 144)
  assert.equal(buckets[0].time, time - 143 * 300)
  assert.deepEqual(buckets.at(-1), {
    time,
    status: 'degraded',
    reported: 2,
    total: 3,
    checks: 35,
    failures: 1,
    avgLatencyMs: 900 / 35,
  })
  assert.equal(buckets.at(-2).avgLatencyMs, null)
  assert.equal(buckets.at(-2).reported, 1)
  assert.equal(buckets.at(-2).status, 'up')
  assert.equal(summarizeProbeHistory([], time + 300).at(-1).time, time + 300)
})
