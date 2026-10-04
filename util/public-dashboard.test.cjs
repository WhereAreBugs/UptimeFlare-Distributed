const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const Module = require('node:module')
const ts = require('typescript')
function load(name) {
  const filename = path.join(__dirname, name)
  const compiled = new Module(filename, module)
  compiled.filename = filename
  compiled.paths = module.paths
  compiled._compile(
    ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText,
    filename
  )
  return compiled.exports
}
const { visiblePublicMonitors, publicMonitorGroups, publicMonitorPage } =
  load('public-monitor-list.ts')
const { createPublicHistoryLoader, withProbeHistory } = load('public-history-loader.ts')
const flush = () => new Promise((resolve) => setImmediate(resolve))
const full = (id) => ({
  monitorId: id,
  summary: { monitorId: id, probes: [], historyLoaded: true },
})

test('74-target dashboard hides58 paused cards, keeps11 active Mac targets, and mounts at most10 per group page', () => {
  const monitors = Array.from({ length: 74 }, (_, index) => ({
    id: `target-${index}`,
    paused: index < 58,
  }))
  const mac = monitors.slice(0, 69).map((monitor) => monitor.id)
  const active = visiblePublicMonitors(monitors, {})
  assert.equal(active.length, 16)
  const groups = publicMonitorGroups(
    active,
    { mac, hidden: monitors.slice(0, 58).map((monitor) => monitor.id) },
    'Other'
  )
  assert.deepEqual(
    groups.map((group) => [group.name, group.monitors.length]),
    [
      ['mac', 11],
      ['Other', 5],
    ]
  )
  assert.deepEqual(
    publicMonitorPage(groups[0].monitors, 1).items.map((monitor) => monitor.id),
    mac.slice(58, 68)
  )
  assert.deepEqual(
    publicMonitorPage(groups[0].monitors, 2).items.map((monitor) => monitor.id),
    ['target-68']
  )
  assert.equal(
    monitors.filter((monitor) => monitor.paused).length,
    58,
    'the original aggregate input retains closed targets'
  )
})

test('saved group order and shared membership survive filtering; wholly paused and unknown IDs do not create groups', () => {
  const monitors = [{ id: 'a' }, { id: 'b' }, { id: 'closed' }, { id: 'ungrouped' }]
  const active = visiblePublicMonitors(monitors, { closed: { status: 'paused' } })
  const groups = publicMonitorGroups(
    active,
    { First: ['b', 'missing', 'a', 'a'], Second: ['a'], Closed: ['closed'], Other: ['closed'] },
    'Other'
  )
  assert.deepEqual(
    groups.map((group) => [group.name, group.monitors.map((monitor) => monitor.id)]),
    [
      ['First', ['b', 'a']],
      ['Second', ['a']],
      ['Other (2)', ['ungrouped']],
    ]
  )
  assert.deepEqual(publicMonitorGroups([], { Closed: ['closed'] }, 'Other'), [])
  assert.equal(
    publicMonitorPage(active, 99).page,
    1,
    'pausing targets clamps an old page without hiding survivors'
  )
})

test('visible-history loading never exceeds two requests and a target remains deduplicated across refresh versions', async () => {
  const waiting = []
  let running = 0,
    maximum = 0,
    requests = 0
  const loader = createPublicHistoryLoader(
    (id) =>
      new Promise((resolve) => {
        requests++
        maximum = Math.max(maximum, ++running)
        waiting.push(() => {
          running--
          resolve(full(id))
        })
      })
  )
  const first = loader.load('target-0', 1)
  assert.equal(loader.load('target-0', 2), first)
  const reads = [
    first,
    ...Array.from({ length: 19 }, (_, index) => loader.load(`target-${index + 1}`, 1)),
  ]
  await flush()
  assert.equal(requests, 2)
  while (requests < 20 || waiting.length) {
    waiting.splice(0).forEach((resolve) => resolve())
    await flush()
  }
  assert.equal((await Promise.all(reads)).length, 20)
  assert.equal(maximum, 2)
  assert.equal(requests, 20)
})

test('history cache is bounded, reuses unchanged versions, and refreshes changed or five-minute-old history', async () => {
  let time = 0
  const requests = []
  const loader = createPublicHistoryLoader(
    async (id) => {
      requests.push(id)
      return full(id)
    },
    2,
    () => time
  )
  await loader.load('a', 1)
  await flush()
  await loader.load('b', 1)
  await flush()
  await loader.load('a', 1)
  await loader.load('c', 1)
  await flush()
  await loader.load('b', 1)
  await flush()
  assert.deepEqual(requests, ['a', 'b', 'c', 'b'])
  await loader.load('b', 2)
  await flush()
  time = 300000
  await loader.load('b', 2)
  assert.deepEqual(requests, ['a', 'b', 'c', 'b', 'b', 'b'])
})

test('a failed or mismatched history response cannot poison the cache or block queued targets', async () => {
  let fail = true
  const loader = createPublicHistoryLoader(async (id) =>
    fail ? { monitorId: 'wrong', historyLoaded: true } : full(id)
  )
  await assert.rejects(loader.load('target', 1), /Invalid monitor history/)
  await flush()
  fail = false
  assert.equal((await loader.load('target', 1)).monitorId, 'target')
  assert.throws(() => createPublicHistoryLoader(async (id) => full(id), 0), /capacity/)
})

test('old lazy history never overrides fresh reachability or restores a removed probe', () => {
  const light = {
    monitorId: 'target',
    status: 'down',
    latest: 200,
    probes: [{ id: 'a', status: 'down', latest: 200, history: [] }],
  }
  const history = {
    monitorId: 'target',
    status: 'up',
    latest: 100,
    dailyHistory: [{ time: 0 }],
    probes: [
      {
        id: 'a',
        status: 'up',
        latest: 100,
        history: [{ time: 0 }],
        dailyHistory: [],
        recentFailures: [],
        failureStages: {},
      },
      { id: 'removed', history: [{ time: 0 }] },
    ],
  }
  const merged = withProbeHistory(light, history)
  assert.equal(merged.status, 'down')
  assert.equal(merged.latest, 200)
  assert.deepEqual(
    merged.probes.map((probe) => probe.id),
    ['a']
  )
  assert.equal(merged.probes[0].status, 'down')
  assert.deepEqual(merged.probes[0].history, [{ time: 0 }])
  assert.equal(withProbeHistory(light, { ...history, monitorId: 'other' }), light)
})

test('full diagnostics return only for matching fresh sample identities without replacing current failure stages', () => {
  const light = {
    monitorId: 'target',
    retainedFrom: null,
    probes: [
      {
        id: 'a',
        latest: 100,
        status: 'down',
        stale: false,
        stage: 'tcp',
        code: 'refused',
        history: [],
      },
    ],
  }
  const history = {
    monitorId: 'target',
    retainedFrom: 50,
    probes: [
      {
        id: 'a',
        latest: 100,
        status: 'down',
        message: 'Connection was refused',
        stage: 'old',
        code: 'old',
        history: [],
        dailyHistory: [],
        recentFailures: [],
        failureStages: {},
      },
    ],
  }
  const merged = withProbeHistory(light, history)
  assert.equal(merged.probes[0].message, 'Connection was refused')
  assert.equal(merged.probes[0].stage, 'tcp')
  assert.equal(merged.probes[0].code, 'refused')
  assert.equal(merged.retainedFrom, 50)
  for (const patch of [
    { latest: 101 },
    { status: 'up' },
    { stale: true, status: 'unknown', message: 'No recent result' },
  ]) {
    const fresh = { ...light, probes: [{ ...light.probes[0], ...patch }] }
    assert.equal(withProbeHistory(fresh, history).probes[0].message, patch.message)
  }
})
