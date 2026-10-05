import type { ProbeEnv } from './probes'
import type { ProbeResult } from '../../types/probes'
import type { StageDelta } from './probe-counters'

// Reserved identities cannot collide with validated monitor IDs. Existing scalar
// rows keep their original keys; no schema change or eager history rewrite is needed.
export const FAILURE_PREFIX = '@failure:v1:'
export const FAILURE_MARKER = '@packed:v1'
export const FAILURE_DAY = 86400
export const MAX_FAILURE_BYTES = 32 * 1024
export const MAX_FAILURE_SAMPLES = 4096
export const MAX_FAILURE_CHUNKS = 128
const MAX_READ_BYTES = 8 * 1024 * 1024
const MAX_READ_CHUNKS = 2048
export type FailureRow = {
  probe_id: string
  monitor_id: string
  time: number
  stage: string
  code: string
  message: string
}
type Pair = { probe_id: string; monitor_id: string }
type Run = [number, number, number] // UTC-day offset, exact step in seconds, count
export type FailureDocument = {
  version: 1
  count: number
  groups: { stage: string; code: string; message: string; runs: Run[] }[]
}
const dayOf = (time: number) => Math.floor(time / FAILURE_DAY) * FAILURE_DAY
const bytes = (value: string) => new TextEncoder().encode(value).byteLength
const identity = (row: Pair, day: number) => JSON.stringify([row.probe_id, row.monitor_id, day])
export const failureOrder = (a: FailureRow, b: FailureRow) =>
  b.time - a.time || compare(b.monitor_id, a.monitor_id) || compare(b.probe_id, a.probe_id)
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)
export const beforeCursor = (row: FailureRow, cursor: [number, string, string]) =>
  row.time < cursor[0] ||
  (row.time === cursor[0] &&
    (row.monitor_id < cursor[1] || (row.monitor_id === cursor[1] && row.probe_id < cursor[2])))

export function encodeFailureDocument(rows: FailureRow[], day: number): FailureDocument {
  const groups = new Map<string, FailureDocument['groups'][number]>()
  for (const row of [...rows].sort((a, b) => a.time - b.time)) {
    if (dayOf(row.time) !== day) throw new Error('Failure day mismatch')
    const key = JSON.stringify([row.stage, row.code, row.message]),
      group = groups.get(key) ?? {
        stage: row.stage,
        code: row.code,
        message: row.message,
        runs: [],
      },
      offset = row.time - day,
      last = group.runs[group.runs.length - 1]
    if (last && last[2] === 1) {
      last[1] = offset - last[0]
      last[2]++
    } else if (last && offset === last[0] + last[1] * last[2]) last[2]++
    else group.runs.push([offset, 0, 1])
    groups.set(key, group)
  }
  return { version: 1, count: rows.length, groups: [...groups.values()] }
}

export function parseFailureDocument(row: FailureRow): FailureDocument {
  if (
    !row.monitor_id.startsWith(FAILURE_PREFIX) ||
    row.stage !== FAILURE_MARKER ||
    !Number.isSafeInteger(row.time) ||
    row.time < 0 ||
    row.time - dayOf(row.time) >= MAX_FAILURE_CHUNKS ||
    bytes(row.message) > MAX_FAILURE_BYTES
  )
    throw new Error('Invalid packed failure row')
  const value = JSON.parse(row.message) as FailureDocument
  if (
    value.version !== 1 ||
    !Array.isArray(value.groups) ||
    !value.groups.length ||
    !Number.isSafeInteger(value.count) ||
    value.count < 1 ||
    value.count > MAX_FAILURE_SAMPLES
  )
    throw new Error('Unsupported packed failures')
  let count = 0,
    lastTime = -1
  const seen = new Set<number>(),
    reasons = new Set<string>()
  for (const group of value.groups) {
    if (
      !group ||
      typeof group.stage !== 'string' ||
      typeof group.code !== 'string' ||
      typeof group.message !== 'string' ||
      !Array.isArray(group.runs) ||
      !group.runs.length
    )
      throw new Error('Invalid packed failure group')
    const reason = JSON.stringify([group.stage, group.code, group.message])
    if (reasons.has(reason)) throw new Error('Duplicate packed failure group')
    reasons.add(reason)
    let prior = -1
    for (const run of group.runs) {
      if (
        !Array.isArray(run) ||
        run.length !== 3 ||
        run.some((v) => !Number.isSafeInteger(v)) ||
        run[0] < 0 ||
        run[0] <= prior ||
        run[1] < 0 ||
        run[2] < 1 ||
        (run[2] > 1 && run[1] === 0) ||
        (run[2] === 1 && run[1] !== 0) ||
        run[0] + run[1] * (run[2] - 1) >= FAILURE_DAY ||
        count + run[2] > MAX_FAILURE_SAMPLES
      )
        throw new Error('Invalid packed failure times')
      for (let i = 0; i < run[2]; i++) {
        const time = run[0] + i * run[1]
        if (seen.has(time)) throw new Error('Duplicate packed failure time')
        seen.add(time)
        lastTime = Math.max(lastTime, dayOf(row.time) + time)
      }
      count += run[2]
      prior = run[0] + run[1] * (run[2] - 1)
    }
  }
  if (count !== value.count || String(lastTime) !== row.code)
    throw new Error('Packed failure count/time mismatch')
  return value
}
function expand(row: FailureRow, document = parseFailureDocument(row)): FailureRow[] {
  const result: FailureRow[] = [],
    day = dayOf(row.time)
  for (const group of document.groups)
    for (const [start, step, count] of group.runs)
      for (let i = 0; i < count; i++)
        result.push({
          stage: group.stage,
          code: group.code,
          message: group.message,
          probe_id: row.probe_id,
          monitor_id: row.monitor_id.slice(FAILURE_PREFIX.length),
          time: day + start + i * step,
        })
  return result
}
function checkBudget(rows: FailureRow[], budget: { rows: number; bytes: number }) {
  budget.rows += rows.length
  budget.bytes += rows.reduce((sum, row) => sum + bytes(row.message), 0)
  if (budget.rows > MAX_READ_CHUNKS || budget.bytes > MAX_READ_BYTES)
    throw new Error('Packed failure read budget exceeded')
}
function split(rows: FailureRow[], day: number): FailureDocument[] {
  const document = encodeFailureDocument(rows, day)
  if (rows.length <= MAX_FAILURE_SAMPLES && bytes(JSON.stringify(document)) <= MAX_FAILURE_BYTES)
    return [document]
  if (rows.length === 1) throw new Error('Failure exceeds block budget')
  const middle = Math.floor(rows.length / 2)
  return [...split(rows.slice(0, middle), day), ...split(rows.slice(middle), day)]
}

/** Only the last bounded chunk is rewritten. Identical causes share one exact
 * timestamp series; a 288-check outage normally occupies a single small group. */
export async function preparePackedFailures(
  env: ProbeEnv,
  probeId: string,
  results: ProbeResult[],
  guard: string
): Promise<D1PreparedStatement[]> {
  const incoming = new Map<string, { monitor_id: string; day: number; rows: FailureRow[] }>()
  for (const result of results.filter((r) => !r.up)) {
    const day = dayOf(result.time),
      key = identity({ probe_id: probeId, monitor_id: result.monitor_id }, day),
      value = incoming.get(key) ?? { monitor_id: result.monitor_id, day, rows: [] }
    value.rows.push({
      probe_id: probeId,
      monitor_id: result.monitor_id,
      time: result.time,
      stage: result.stage ?? '',
      code: result.code ?? '',
      message: result.message ?? '',
    })
    incoming.set(key, value)
  }
  if (!incoming.size) return []
  const data = await env.UPTIMEFLARE_D1.prepare(
    `WITH wanted AS (SELECT json_extract(value,'$[0]') id,json_extract(value,'$[1]') day FROM json_each(?))
     SELECT f.* FROM wanted a JOIN probe_failure_events f ON f.probe_id=? AND f.monitor_id=?||a.id
       AND f.time=(SELECT MAX(time) FROM probe_failure_events WHERE probe_id=f.probe_id AND monitor_id=f.monitor_id AND time>=a.day AND time<a.day+${MAX_FAILURE_CHUNKS})`
  )
    .bind(
      JSON.stringify([...incoming.values()].map((v) => [v.monitor_id, v.day])),
      probeId,
      FAILURE_PREFIX
    )
    .all<FailureRow>()
  if (!data.success) throw new Error('Packed failure read failed')
  checkBudget(data.results, { rows: 0, bytes: 0 })
  const previous = new Map(
    data.results.map((row) => [
      identity(
        { ...row, monitor_id: row.monitor_id.slice(FAILURE_PREFIX.length) },
        dayOf(row.time)
      ),
      row,
    ])
  )
  const packed: FailureRow[] = []
  for (const [key, value] of incoming) {
    const prior = previous.get(key),
      chunk = prior ? prior.time - value.day : 0,
      rows = [...(prior ? expand(prior) : []), ...value.rows].sort((a, b) => a.time - b.time)
    if (new Set(rows.map((row) => row.time)).size !== rows.length)
      throw new Error('Packed failure duplicate/inconsistent history')
    const documents = split(rows, value.day)
    if (chunk + documents.length > MAX_FAILURE_CHUNKS)
      throw new Error('Failure day capacity exceeded')
    for (let i = 0; i < documents.length; i++) {
      const document = documents[i],
        last = Math.max(
          ...document.groups.flatMap((g) => g.runs.map(([t, s, n]) => value.day + t + s * (n - 1)))
        )
      packed.push({
        probe_id: probeId,
        monitor_id: FAILURE_PREFIX + value.monitor_id,
        time: value.day + chunk + i,
        stage: FAILURE_MARKER,
        code: String(last),
        message: JSON.stringify(document),
      })
    }
  }
  const batches: FailureRow[][] = []
  let batch: FailureRow[] = []
  for (const row of packed) {
    if (batch.length && bytes(JSON.stringify([...batch, row])) > 256 * 1024) {
      batches.push(batch)
      batch = []
    }
    batch.push(row)
  }
  if (batch.length) batches.push(batch)
  return batches.map((values) =>
    env.UPTIMEFLARE_D1.prepare(
      `INSERT INTO probe_failure_events(probe_id,monitor_id,time,stage,code,message)
     SELECT ?,json_extract(value,'$.monitor_id'),json_extract(value,'$.time'),json_extract(value,'$.stage'),json_extract(value,'$.code'),json_extract(value,'$.message') FROM json_each(?) WHERE (${guard})
     ON CONFLICT(probe_id,monitor_id,time) DO UPDATE SET stage=excluded.stage,code=excluded.code,message=excluded.message`
    ).bind(probeId, JSON.stringify(values))
  )
}

/** Recent failures remain individual observations in the API. Chunk upper
 * bounds allow stopping once older chunks cannot change the requested page. */
export async function readPackedFailures(
  env: ProbeEnv,
  pairs: Pair[],
  from: number,
  to: number,
  cursor: [number, string, string],
  limit: number
): Promise<FailureRow[]> {
  const budget = { rows: 0, bytes: 0 },
    found: FailureRow[] = []
  let after: [number, string, string, number] | undefined
  const upperDay = dayOf(Math.min(to - 1, cursor[0]))
  while (true) {
    const data = await env.UPTIMEFLARE_D1.prepare(
      `WITH assigned AS (SELECT json_extract(value,'$.probe_id') probe_id,?||json_extract(value,'$.monitor_id') monitor_id FROM json_each(?))
       SELECT s.* FROM assigned a JOIN probe_failure_events s ON s.probe_id=a.probe_id AND s.monitor_id=a.monitor_id
        AND s.time IN (SELECT f.time FROM probe_failure_events f WHERE f.probe_id=a.probe_id AND f.monitor_id=a.monitor_id
          AND f.time>=? AND f.time<? ORDER BY f.time DESC LIMIT ${limit + MAX_FAILURE_CHUNKS})
       WHERE CAST(s.code AS INTEGER)>=? ${
         after ? 'AND (CAST(s.code AS INTEGER),s.monitor_id,s.probe_id,s.time)<(?,?,?,?)' : ''
       }
       ORDER BY CAST(s.code AS INTEGER) DESC,s.monitor_id DESC,s.probe_id DESC,s.time DESC LIMIT 32`
    )
      .bind(
        FAILURE_PREFIX,
        JSON.stringify(pairs),
        dayOf(from),
        upperDay + MAX_FAILURE_CHUNKS,
        from,
        ...(after ?? [])
      )
      .all<FailureRow>()
    if (!data.success) throw new Error('Packed incident read failed')
    checkBudget(data.results, budget)
    for (const row of data.results)
      found.push(
        ...expand(row).filter((r) => r.time >= from && r.time < to && beforeCursor(r, cursor))
      )
    found.sort(failureOrder)
    if (found.length > limit) found.length = limit
    const tail = data.results[data.results.length - 1]
    if (!tail || data.results.length < 32) return found
    // A chunk's maximum observation bounds all of its remaining candidates.
    const bound = {
      ...tail,
      monitor_id: tail.monitor_id.slice(FAILURE_PREFIX.length),
      time: Number(tail.code),
    }
    if (found.length >= limit && failureOrder(bound, found[limit - 1]) >= 0) return found
    after = [Number(tail.code), tail.monitor_id, tail.probe_id, tail.time]
  }
}

/** Cleanup subtracts stages from exact expired five-minute buckets. Legacy
 * bucket-stage rows are handled separately, so mixed formats never double-add. */
export async function packedFailureStageDeltas(
  env: ProbeEnv,
  buckets: (Pair & { time: number })[]
): Promise<StageDelta[]> {
  if (!buckets.length) return []
  const wanted = new Map<string, { pair: Pair; day: number; windows: Set<number> }>()
  for (const bucket of buckets) {
    const day = dayOf(bucket.time),
      key = identity(bucket, day),
      value = wanted.get(key) ?? { pair: bucket, day, windows: new Set<number>() }
    value.windows.add(bucket.time)
    wanted.set(key, value)
  }
  const data = await env.UPTIMEFLARE_D1.prepare(
    `WITH wanted AS (SELECT json_extract(value,'$[0]') probe_id,?||json_extract(value,'$[1]') monitor_id,json_extract(value,'$[2]') day FROM json_each(?))
     SELECT f.* FROM wanted a JOIN probe_failure_events f ON f.probe_id=a.probe_id AND f.monitor_id=a.monitor_id AND f.time>=a.day AND f.time<a.day+${MAX_FAILURE_CHUNKS} LIMIT ${
       MAX_READ_CHUNKS + 1
     }`
  )
    .bind(
      FAILURE_PREFIX,
      JSON.stringify([...wanted.values()].map((v) => [v.pair.probe_id, v.pair.monitor_id, v.day]))
    )
    .all<FailureRow>()
  if (!data.success) throw new Error('Packed failure expiration read failed')
  checkBudget(data.results, { rows: 0, bytes: 0 })
  const deltas: StageDelta[] = []
  for (const row of data.results) {
    const monitor_id = row.monitor_id.slice(FAILURE_PREFIX.length),
      day = dayOf(row.time),
      target = wanted.get(identity({ ...row, monitor_id }, day))!
    for (const group of parseFailureDocument(row).groups) {
      let failures = 0
      for (const [start, step, count] of group.runs)
        for (const window of target.windows) {
          const lo = window - day,
            hi = lo + 300
          if (!step) failures += start >= lo && start < hi ? 1 : 0
          else
            failures += Math.max(
              0,
              Math.min(count, Math.ceil((hi - start) / step)) -
                Math.max(0, Math.ceil((lo - start) / step))
            )
        }
      if (failures)
        deltas.push({ probe_id: row.probe_id, monitor_id, stage: group.stage, failures })
    }
  }
  return deltas
}

export async function readPackedFailureSummaries(
  env: ProbeEnv,
  pairs: Pair[],
  from: number,
  to: number
) {
  const data = await env.UPTIMEFLARE_D1.prepare(
    `WITH assigned AS (SELECT json_extract(value,'$.probe_id') probe_id,?||json_extract(value,'$.monitor_id') monitor_id FROM json_each(?))
     SELECT s.* FROM assigned a JOIN probe_failure_events s ON s.probe_id=a.probe_id AND s.monitor_id=a.monitor_id
       AND s.time IN (SELECT f.time FROM probe_failure_events f WHERE f.probe_id=a.probe_id AND f.monitor_id=a.monitor_id
         AND f.time>=? AND f.time<? ORDER BY f.time DESC LIMIT ${100 + MAX_FAILURE_CHUNKS})
     ORDER BY s.probe_id,s.monitor_id,s.time DESC`
  )
    .bind(FAILURE_PREFIX, JSON.stringify(pairs), dayOf(from), dayOf(to - 1) + MAX_FAILURE_CHUNKS)
    .all<FailureRow>()
  if (!data.success) throw new Error('Packed failure summary read failed')
  // A production history query contains one target and at most 33 assignments.
  if (
    data.results.length > 8192 ||
    data.results.reduce((sum, row) => sum + bytes(row.message), 0) > MAX_READ_BYTES
  )
    throw new Error('Packed failure summary read budget exceeded')
  const found = new Map<string, FailureRow[]>(),
    complete = new Set<string>()
  for (const row of data.results) {
    const key = JSON.stringify([row.probe_id, row.monitor_id])
    if (complete.has(key)) continue
    const events = found.get(key) ?? []
    events.push(...expand(row).filter((r) => r.time >= from && r.time < to))
    events.sort(failureOrder)
    if (events.length > 100) events.length = 100
    found.set(key, events)
    if (events.length === 100 && row.time === dayOf(row.time)) complete.add(key)
  }
  return [...found.values()].flat()
}
