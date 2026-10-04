const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
function load(filename) {
  const compiled = new Module(filename, module)
  compiled.filename = filename
  compiled.paths = module.paths
  compiled.require = (id) =>
    id.startsWith('.') ? load(path.resolve(path.dirname(filename), `${id}.ts`)) : module.require(id)
  compiled._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    filename
  )
  return compiled.exports
}
const { guardPublicSnapshot, isPublicSnapshotUnavailable } = load(
  path.join(__dirname, 'public-snapshot.ts')
)
const { summarizeDashboardMonitors } = load(path.join(__dirname, 'dashboard-status.ts'))
const { refreshProbeSummary } = load(path.join(__dirname, 'probe-status.ts'))
const { PUBLIC_SNAPSHOT_MAX_AGE_SECONDS: ttl } = load(
  path.join(__dirname, '../types/public-dashboard.ts')
)
const now = 1_800_000_000
const state = {
  lastUpdate: now,
  overallUp: 1,
  overallDown: 0,
  latency: { native: [{ time: now, ping: 10, loc: 'SIN' }] },
  incident: { native: [{ start: [now - 1], end: now - 1, error: ['dummy'] }] },
}
const probe = {
  id: 'p',
  status: 'up',
  stale: false,
  latest: now,
  latencyMs: 10,
  history: [{ time: now, checks: 1, failures: 0, avgLatencyMs: 10 }],
}
const summary = {
  monitorId: 'external',
  status: 'up',
  up: 1,
  down: 0,
  unknown: 0,
  total: 1,
  latest: now,
  probes: [probe],
}

test('KV freshness expires at the shared snapshot boundary even if a target interval is one day', () => {
  const snapshot = { snapshotAt: now, source: 'kv', stale: false, snapshotIncomplete: false }
  assert.equal(isPublicSnapshotUnavailable(snapshot, now + ttl), false)
  assert.equal(isPublicSnapshotUnavailable(snapshot, now + ttl + 1), true)
  for (const patch of [
    { stale: true },
    { snapshotIncomplete: true },
    { snapshotAt: null },
    { snapshotAt: Infinity },
  ])
    assert.equal(isPublicSnapshotUnavailable({ ...snapshot, ...patch }, now), true)
  assert.equal(
    isPublicSnapshotUnavailable({ source: 'd1' }, now),
    false,
    'existing local installations have no snapshot deadline'
  )
})

test('stale or metadata-only status cannot become healthy through native data, a recent success, or a clock behind the producer', () => {
  const monitors = [
    { id: 'native', intervalSeconds: 86400 },
    { id: 'external', probes: ['p'], intervalSeconds: 86400 },
    { id: 'closed', paused: true, probes: ['p'] },
  ]
  const closed = { ...summary, monitorId: 'closed', status: 'paused', paused: true }
  const summaries = { external: summary, closed }
  for (const metadata of [{ stale: true }, { snapshotIncomplete: true, snapshotAt: now }]) {
    const guarded = guardPublicSnapshot(
      state,
      summaries,
      isPublicSnapshotUnavailable(metadata, now)
    )
    const counts = summarizeDashboardMonitors(
      monitors,
      guarded.state,
      guarded.summaries,
      [],
      now - 60
    )
    assert.deepEqual([counts.healthy, counts.closed, counts.abnormal], [0, 1, 2])
    const refreshed = refreshProbeSummary(guarded.summaries.external, now - 60, monitors[1])
    assert.equal(refreshed.status, 'unknown')
    assert.deepEqual([refreshed.up, refreshed.down, refreshed.unknown], [0, 0, 1])
    assert.equal(guarded.summaries.closed, closed)
    assert.equal(
      guarded.summaries.external.probes[0].history,
      probe.history,
      'historical measurements stay intact'
    )
    assert.equal(guarded.summaries.external.latest, now)
  }
  assert.equal(summary.status, 'up', 'the original retained snapshot is immutable')
  assert.equal(state.latency.native.length, 1)
  assert.equal(guardPublicSnapshot(state, summaries, false).summaries, summaries)
})
