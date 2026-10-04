const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')

function load(filename) {
  const loaded = new Module(filename, module)
  loaded.filename = filename
  loaded.paths = module.paths
  loaded.require = (id) =>
    id.startsWith('.') ? load(path.resolve(path.dirname(filename), `${id}.ts`)) : require(id)
  loaded._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    filename
  )
  return loaded.exports
}
const { getMonitorCategory, summarizeDashboardMonitors, dashboardCategory } = load(
  path.join(__dirname, 'dashboard-status.ts')
)
const { refreshProbeSummary, summarizeProbeHistory } = load(path.join(__dirname, 'probe-status.ts'))
const now = 1_800_000_000
const monitor = { id: 'host', name: 'Host', method: 'GET', target: 'https://example.test' }
const state = { lastUpdate: 0, overallUp: 0, overallDown: 0, incident: {}, latency: {} }
const active = [{ start: now - 60, end: now + 60, body: 'Maintenance' }]
function summary(status, paused = false) {
  const probe = {
    id: 'p',
    status: status === 'up' ? 'up' : 'down',
    latest: now - 1,
    stale: false,
    history: [{ time: now, checks: 1, failures: 0, avgLatencyMs: 8 }],
  }
  return {
    monitorId: 'host',
    status,
    paused,
    up: status === 'up' ? 1 : 0,
    down: status === 'down' ? 1 : 0,
    unknown: status === 'unknown' ? 1 : 0,
    total: 1,
    latest: now - 1,
    probes: [probe],
  }
}

test('paused has priority over active maintenance and a retained successful measurement', () => {
  assert.equal(getMonitorCategory({ ...monitor, paused: true }, 'up', active, now), 'closed')
  assert.equal(getMonitorCategory(monitor, 'paused', active, now), 'closed')
  assert.equal(getMonitorCategory(monitor, 'down', active, now), 'maintenance')
  assert.equal(getMonitorCategory(monitor, 'unknown', active, now), 'maintenance')
  for (const status of ['down', 'degraded', 'unknown'])
    assert.equal(getMonitorCategory(monitor, status, [], now), 'abnormal')
  assert.equal(getMonitorCategory(monitor, 'up', [], now), 'healthy')
})

test('specific, global, future and ended maintenance classify only currently affected targets', () => {
  const plans = [
    { start: (now - 60) * 1000, end: (now + 60) * 1000, body: 'Specific', monitors: ['other'] },
    { start: new Date((now + 1) * 1000).toISOString(), body: 'Future' },
    { start: now - 120, end: now - 1, body: 'Ended' },
  ]
  assert.equal(getMonitorCategory(monitor, 'up', plans, now), 'healthy')
  assert.equal(getMonitorCategory({ id: 'other' }, 'up', plans, now), 'maintenance')
  assert.equal(
    getMonitorCategory(monitor, 'unknown', [{ start: now, body: 'Global' }], now),
    'maintenance'
  )
})

test('75 targets remain in the total with four exclusive categories and no paused update freshness', () => {
  const monitors = Array.from({ length: 75 }, (_, index) => ({
    ...monitor,
    id: `host-${index}`,
    paused: index < 10,
    probes: ['p'],
  }))
  const summaries = Object.fromEntries(
    monitors.map((target, index) => [
      target.id,
      {
        ...summary(index < 65 ? 'up' : 'down'),
        monitorId: target.id,
        latest: index < 10 ? now + 100 : now - 1,
      },
    ])
  )
  const plans = [
    {
      start: now - 60,
      end: now + 60,
      body: 'Maintenance',
      monitors: monitors.slice(0, 20).map(({ id }) => id),
    },
  ]
  const counts = summarizeDashboardMonitors(monitors, state, summaries, plans, now)
  assert.deepEqual(counts, {
    healthy: 45,
    closed: 10,
    maintenance: 10,
    abnormal: 10,
    total: 75,
    lastUpdate: now - 1,
  })
  assert.equal(dashboardCategory(counts), 'abnormal')
  assert.equal(counts.healthy + counts.closed + counts.maintenance + counts.abnormal, counts.total)
})

test('all paused or maintained groups cannot appear healthy or abnormal because data is missing', () => {
  const targets = [
    { ...monitor, paused: true },
    { ...monitor, id: 'other', paused: true },
  ]
  const closed = summarizeDashboardMonitors(targets, state, {}, active, now)
  assert.deepEqual(closed, {
    healthy: 0,
    closed: 2,
    maintenance: 0,
    abnormal: 0,
    total: 2,
    lastUpdate: 0,
  })
  assert.equal(dashboardCategory(closed), 'closed')
  const maintained = summarizeDashboardMonitors(
    targets.map((target) => ({ ...target, paused: false })),
    state,
    {},
    active,
    now
  )
  assert.equal(maintained.maintenance, 2)
  assert.equal(maintained.abnormal, 0)
  assert.equal(dashboardCategory(maintained), 'maintenance')
})

test('paused server summaries and native targets preserve historical data without counting as healthy', () => {
  const external = { ...monitor, probes: ['p'] }
  const stored = summary('up', true)
  const refreshed = refreshProbeSummary(stored, now, external)
  assert.equal(refreshed.status, 'paused')
  assert.equal(
    refreshProbeSummary({ ...stored, paused: undefined, status: 'paused' }, now, external).status,
    'paused'
  )
  assert.equal(summarizeDashboardMonitors([external], state, { host: stored }, [], now).closed, 1)
  assert.equal(summarizeProbeHistory(stored.probes, now).at(-1).status, 'up')
  assert.equal(stored.status, 'up', 'serialized history is not rewritten by pause')
  const nativeState = {
    ...state,
    latency: { host: [{ time: now, ping: 9, loc: 'SIN' }] },
    incident: { host: [{ start: [now - 1], end: now - 1, error: ['dummy'] }] },
  }
  assert.equal(
    summarizeDashboardMonitors([{ ...monitor, paused: true }], nativeState, {}, [], now).closed,
    1
  )
  assert.equal(summarizeDashboardMonitors([monitor], nativeState, {}, [], now).healthy, 1)
})
