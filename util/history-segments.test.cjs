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
const { mergeHistorySegments } = load(path.join(__dirname, 'history-segments.ts'))
const { summarizeProbeHistory, summarizeProbeDailyHistory } = load(
  path.join(__dirname, 'probe-status.ts')
)
const dayStatus = (day) =>
  !day.checks ? 'unknown' : !day.failures ? 'up' : day.failures === day.checks ? 'down' : 'degraded'

test('144 real five-minute buckets retain failures, missing coverage and proportional width', () => {
  const end = 1_800_000
  const histories = [[], []]
  for (let index = 12; index < 144; index++) {
    const down = index >= 114 && index < 134
    const mixed = index >= 110 && index < 114
    const time = end - (143 - index) * 300
    histories[0].push({ time, checks: 1, failures: down ? 1 : 0, avgLatencyMs: down ? null : 10 })
    histories[1].push({
      time,
      checks: 3,
      failures: down || mixed ? 3 : 0,
      avgLatencyMs: down || mixed ? null : 30,
    })
  }
  const buckets = Object.freeze(
    summarizeProbeHistory(
      histories.map((history) => ({ history })),
      end
    ).map(Object.freeze)
  )
  const segments = mergeHistorySegments(buckets, 300)
  assert.deepEqual(
    segments.map(({ status, bucketCount }) => [status, bucketCount]),
    [
      ['unknown', 12],
      ['up', 98],
      ['degraded', 4],
      ['down', 20],
      ['up', 10],
    ]
  )
  assert.deepEqual(
    segments.map(({ firstIndex, lastIndex }) => [firstIndex, lastIndex]),
    [
      [0, 11],
      [12, 109],
      [110, 113],
      [114, 133],
      [134, 143],
    ]
  )
  assert.equal(segments[0].widthRatio, 12 / 144)
  assert.equal(segments[1].widthRatio, 98 / 144)
  assert(Math.abs(segments.reduce((sum, segment) => sum + segment.widthRatio, 0) - 1) < 1e-12)
  assert.equal(segments[0].startTime, end - 143 * 300)
  assert.equal(segments.at(-1).endTime, end + 300)
  assert.equal(
    segments.reduce((sum, segment) => sum + segment.checks, 0),
    528
  )
  assert.equal(
    segments.reduce((sum, segment) => sum + segment.failures, 0),
    92
  )
  assert.equal(segments[1].avgLatencyMs, 25)
  assert.equal(segments[2].avgLatencyMs, null)
  assert.equal(buckets.length, 144, 'the source remains intact for per-bucket tooltips')
})

test('90 UTC days preserve daily sample weights rather than averaging percentages or latency equally', () => {
  const end = Math.floor(1_800_000 / 86400) * 86400
  const dailyHistory = []
  for (let index = 60; index < 90; index++) {
    const mixed = index >= 75 && index < 80
    const down = index >= 80
    const checks = mixed ? 10 : down ? 2 : index === 74 ? 9 : 1
    dailyHistory.push({
      time: end - (89 - index) * 86400,
      checks,
      failures: mixed || down ? 2 : 0,
      latencyChecks: mixed ? 3 : down ? 0 : checks,
      avgLatencyMs: mixed ? 50 : down ? null : index === 74 ? 30 : 10,
    })
  }
  const buckets = summarizeProbeDailyHistory([{ dailyHistory }], end).map((day) => ({
    ...day,
    status: dayStatus(day),
  }))
  const segments = mergeHistorySegments(buckets, 86400)
  assert.deepEqual(
    segments.map(({ status, bucketCount }) => [status, bucketCount]),
    [
      ['unknown', 60],
      ['up', 15],
      ['degraded', 5],
      ['down', 10],
    ]
  )
  assert.equal(segments[0].widthRatio, 60 / 90)
  assert.equal(segments[1].checks, 23)
  assert.equal(segments[1].avgLatencyMs, 410 / 23)
  assert.equal(segments[2].checks, 50)
  assert.equal(segments[2].failures, 10)
  assert.equal(segments[2].latencyChecks, 15)
  assert.equal(segments[2].avgLatencyMs, 50)
  assert.equal(
    segments.reduce((sum, segment) => sum + segment.checks, 0),
    93
  )
  assert.equal(
    segments.reduce((sum, segment) => sum + segment.failures, 0),
    30
  )
  assert.equal(segments.at(-1).endTime, end + 86400)
})

test('equal status across time gaps, duplicate times or backwards times stays separate', () => {
  const bucket = (time) => ({ time, status: 'up', checks: 1, failures: 0, avgLatencyMs: 0 })
  const segments = mergeHistorySegments([0, 300, 900, 1200, 1200, 600].map(bucket), 300)
  assert.deepEqual(
    segments.map(({ startTime, endTime, bucketCount }) => [startTime, endTime, bucketCount]),
    [
      [0, 600, 2],
      [900, 1500, 2],
      [1200, 1500, 1],
      [600, 900, 1],
    ]
  )
  assert.deepEqual(
    segments.map(({ widthRatio }) => widthRatio),
    [2 / 6, 2 / 6, 1 / 6, 1 / 6]
  )
  assert.equal(segments[0].avgLatencyMs, 0, 'a true zero latency remains a measurement')
})

test('unknown boundaries and alternating failures never disappear during compression', () => {
  const states = ['unknown', 'up', 'unknown', 'down', 'degraded', 'unknown']
  const buckets = states.map((status, index) => ({
    time: index * 300,
    status,
    checks: status === 'unknown' ? 0 : 1,
    failures: status === 'down' ? 1 : 0,
  }))
  assert.deepEqual(
    mergeHistorySegments(buckets, 300).map(({ status }) => status),
    states
  )
  const alternating = Array.from({ length: 144 }, (_, index) => ({
    time: index * 300,
    status: index % 2 ? 'down' : 'up',
    checks: 1,
    failures: index % 2,
  }))
  const segments = mergeHistorySegments(alternating, 300)
  assert.equal(segments.length, 144)
  assert(segments.every((segment) => segment.bucketCount === 1 && segment.widthRatio === 1 / 144))
  assert.equal(
    segments.reduce((sum, segment) => sum + segment.failures, 0),
    72
  )
})

test('all-no-data histories cover their full 144-bucket or 90-day width without invented samples', () => {
  for (const [buckets, seconds, expectedCount] of [
    [summarizeProbeHistory([], 1_800_000), 300, 144],
    [
      summarizeProbeDailyHistory([], 1_800_000).map((day) => ({ ...day, status: dayStatus(day) })),
      86400,
      90,
    ],
  ]) {
    const segments = mergeHistorySegments(buckets, seconds)
    assert.equal(segments.length, 1)
    assert.equal(segments[0].status, 'unknown')
    assert.equal(segments[0].bucketCount, expectedCount)
    assert.equal(segments[0].widthRatio, 1)
    assert.equal(segments[0].checks, 0)
    assert.equal(segments[0].failures, 0)
    assert.equal(segments[0].avgLatencyMs, null)
    assert.equal(segments[0].endTime - segments[0].startTime, expectedCount * seconds)
  }
  assert.deepEqual(mergeHistorySegments([], 300), [])
})

test('invalid bucket duration fails explicitly instead of merging unrelated timestamps', () => {
  for (const seconds of [0, -300, NaN, Infinity])
    assert.throws(() => mergeHistorySegments([], seconds), RangeError)
})
