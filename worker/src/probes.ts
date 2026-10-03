import {
  DEFAULT_MONITOR_TIMEOUT_MS,
  getMonitorIntervalSeconds,
  getMonitorStaleAfterSeconds,
  MIN_MONITOR_INTERVAL_SECONDS,
  MAX_MONITOR_INTERVAL_SECONDS,
} from '../../util/monitor-settings'
import type { MonitorTarget } from '../../types/config'
import type {
  ProbeBatch,
  ProbeDefinition,
  ProbeMonitorSummary,
  ProbeResult,
  ProbeSummary,
} from '../../types/probes'
import { CLOUDFLARE_PROBE_ID, recordProbeNetwork, type ProbeNetwork } from './probe-labels'
import { aggregateStatus } from '../../util/probe-status'

export interface ProbeEnv {
  UPTIMEFLARE_D1: D1Database
  /** JSON object mapping stable probe IDs to independent bearer tokens. Set as a secret. */
  PROBE_TOKENS?: string
}
export const MAX_PROBE_BODY = 512 * 1024
export const MAX_PROBE_RESULTS = 200
const RETENTION_SECONDS = 90 * 24 * 60 * 60
const STAGES = new Set(['dns', 'tcp', 'tls', 'http', 'body', 'configuration', 'unknown'])
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/

class ProbeRequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
  }
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

/** Constant-work token comparison for every configured identity, without early matches. */
function sameToken(a: string, b: string): boolean {
  let difference = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    difference |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  }
  return difference === 0
}

function authenticate(request: Request, env: ProbeEnv): string {
  let tokens: Record<string, unknown>
  try {
    tokens = JSON.parse(env.PROBE_TOKENS || '{}')
  } catch {
    throw new ProbeRequestError(503, 'Probe authentication is not configured correctly')
  }
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) {
    throw new ProbeRequestError(503, 'Probe authentication is not configured correctly')
  }
  const entries = Object.entries(tokens)
  const unique = new Set<string>()
  if (entries.length === 0 || entries.length > 32) {
    throw new ProbeRequestError(503, 'Probe authentication is not configured correctly')
  }
  for (const [id, token] of entries) {
    if (
      !ID.test(id) ||
      id === CLOUDFLARE_PROBE_ID ||
      typeof token !== 'string' ||
      token.length < 24 ||
      token.length > 512 ||
      /\s/.test(token) ||
      unique.has(token)
    ) {
      throw new ProbeRequestError(503, 'Probe authentication is not configured correctly')
    }
    unique.add(token)
  }
  const header = request.headers.get('Authorization') || ''
  const supplied = header.startsWith('Bearer ') && header.length <= 519 ? header.slice(7) : ''
  let identity = ''
  for (const [id, token] of entries) {
    if (sameToken(supplied, token as string)) identity = id
  }
  if (!identity) throw new ProbeRequestError(401, 'Invalid probe credentials')
  return identity
}

function assignedMonitors(monitors: MonitorTarget[], probeId: string): MonitorTarget[] {
  if (
    monitors.length > 100 ||
    monitors.reduce((total, monitor) => total + (monitor.probes?.length || 0), 0) > 64 ||
    new Set(monitors.map((m) => m.id)).size !== monitors.length
  ) {
    throw new ProbeRequestError(503, 'Invalid monitor configuration')
  }
  for (const monitor of monitors) {
    if (
      !ID.test(monitor.id) ||
      (monitor.intervalSeconds !== undefined && !Number.isInteger(monitor.intervalSeconds)) ||
      !Number.isInteger(getMonitorIntervalSeconds(monitor)) ||
      getMonitorIntervalSeconds(monitor) < MIN_MONITOR_INTERVAL_SECONDS ||
      getMonitorIntervalSeconds(monitor) > MAX_MONITOR_INTERVAL_SECONDS ||
      (monitor.timeout !== undefined &&
        (!Number.isInteger(monitor.timeout) || monitor.timeout < 1 || monitor.timeout > 120000)) ||
      (monitor.probes &&
        (!Array.isArray(monitor.probes) ||
          monitor.probes.length === 0 ||
          monitor.probes.length > 33 ||
          monitor.probes.some((id) => !ID.test(id)) ||
          new Set(monitor.probes).size !== monitor.probes.length))
    ) {
      throw new ProbeRequestError(503, 'Invalid monitor configuration')
    }
  }
  return monitors.filter((monitor) => monitor.probes?.includes(probeId))
}

/** Limits the stream before buffering; used on both compressed and expanded bodies. */
function limitedStream(
  stream: ReadableStream<Uint8Array>,
  maximum: number
): ReadableStream<Uint8Array> {
  let size = 0
  return stream.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        size += chunk.byteLength
        if (size > maximum) throw new ProbeRequestError(413, 'Probe batch exceeds the body limit')
        controller.enqueue(chunk)
      },
    })
  )
}

async function readBatch(request: Request): Promise<unknown> {
  const length = request.headers.get('Content-Length')
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_PROBE_BODY)) {
    throw new ProbeRequestError(413, 'Probe batch exceeds the body limit')
  }
  if (!request.body) throw new ProbeRequestError(400, 'Missing probe batch')
  const encoding = (request.headers.get('Content-Encoding') || 'identity').toLowerCase()
  if (encoding !== 'identity' && encoding !== 'gzip') {
    throw new ProbeRequestError(415, 'Supported content encodings: identity, gzip')
  }
  if (
    (request.headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase() !==
    'application/json'
  ) {
    throw new ProbeRequestError(415, 'Content-Type must be application/json')
  }
  let body = limitedStream(request.body, MAX_PROBE_BODY)
  if (encoding === 'gzip') body = body.pipeThrough(new DecompressionStream('gzip'))
  try {
    return JSON.parse(await new Response(limitedStream(body, MAX_PROBE_BODY)).text())
  } catch (error) {
    if (error instanceof ProbeRequestError) throw error
    throw new ProbeRequestError(400, 'Invalid JSON or compressed probe batch')
  }
}

function validateBatch(value: unknown, authorized: MonitorTarget[], now: number): ProbeBatch {
  const batch = value as ProbeBatch
  if (
    !batch ||
    typeof batch !== 'object' ||
    Array.isArray(batch) ||
    batch.version !== 1 ||
    typeof batch.batch_id !== 'string' ||
    !/^[a-f0-9]{64}$/.test(batch.batch_id) ||
    !Array.isArray(batch.results) ||
    batch.results.length === 0 ||
    batch.results.length > MAX_PROBE_RESULTS
  ) {
    throw new ProbeRequestError(400, 'Invalid batch version, identity, or result count')
  }
  const monitors = new Set(authorized.map((monitor) => monitor.id))
  const samples = new Set<string>()
  for (const result of batch.results) {
    if (
      !result ||
      typeof result !== 'object' ||
      Array.isArray(result) ||
      typeof result.monitor_id !== 'string' ||
      !ID.test(result.monitor_id)
    ) {
      throw new ProbeRequestError(400, 'Invalid monitor identity')
    }
    if (!monitors.has(result.monitor_id))
      throw new ProbeRequestError(403, 'Probe is not assigned to this monitor')
    if (
      !Number.isSafeInteger(result.time) ||
      result.time < 1577836800 ||
      result.time > now + 300 ||
      typeof result.up !== 'boolean' ||
      typeof result.latency_ms !== 'number' ||
      !Number.isFinite(result.latency_ms) ||
      result.latency_ms < 0 ||
      result.latency_ms > 300000 ||
      (result.stage !== undefined && !STAGES.has(result.stage)) ||
      (result.code !== undefined &&
        (typeof result.code !== 'string' || !/^[a-zA-Z0-9_.-]{1,64}$/.test(result.code))) ||
      (result.message !== undefined &&
        (typeof result.message !== 'string' ||
          result.message.length > 512 ||
          /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(result.message))) ||
      (!result.up && (!result.stage || !result.code))
    ) {
      throw new ProbeRequestError(400, 'Invalid sample timestamp, latency, or diagnostic')
    }
    const key = `${result.monitor_id}:${result.time}`
    if (samples.has(key))
      throw new ProbeRequestError(400, 'Duplicate sample identity within a batch')
    samples.add(key)
  }
  return batch
}

export async function persistBatch(
  env: ProbeEnv,
  probeId: string,
  results: ProbeResult[],
  completionStatements: D1PreparedStatement[] = [],
  gate?: { scope: string; key: string }
): Promise<void> {
  // Normalize absent diagnostics once, so the SQL never persists unvalidated extra JSON fields.
  const payload = JSON.stringify(
    results.map((r) => ({
      monitor_id: r.monitor_id,
      time: r.time,
      up: r.up,
      latency_ms: r.latency_ms,
      stage: r.stage || '',
      code: r.code || '',
      message: r.message || '',
    }))
  )
  const affected = `WITH affected AS (
    SELECT DISTINCT json_extract(value, '$.monitor_id') AS monitor_id,
      CAST(json_extract(value, '$.time') / 300 AS INTEGER) * 300 AS time FROM json_each(?)
  )`
  const statements = [
    env.UPTIMEFLARE_D1.prepare(
      `INSERT OR IGNORE INTO probe_samples
      (probe_id, monitor_id, time, up, latency_ms, stage, code, message)
      SELECT ?, json_extract(value,'$.monitor_id'), json_extract(value,'$.time'),
      json_extract(value,'$.up'), json_extract(value,'$.latency_ms'), json_extract(value,'$.stage'),
      json_extract(value,'$.code'), json_extract(value,'$.message') FROM json_each(?) entry${
        gate
          ? ` WHERE EXISTS (SELECT 1 FROM monitor_schedule schedule WHERE schedule.scope=? AND schedule.monitor_id=json_extract(entry.value,'$.monitor_id') AND schedule.lease_key=?)`
          : ''
      }`
    ).bind(probeId, payload, ...(gate ? [gate.scope, gate.key] : [])),
    // Read the persisted sample, rather than the submitted one: a conflicting replay must not change latest.
    env.UPTIMEFLARE_D1.prepare(
      `INSERT INTO probe_latest
      (probe_id, monitor_id, time, up, latency_ms, stage, code, message)
      SELECT s.probe_id, s.monitor_id, s.time, s.up, s.latency_ms, s.stage, s.code, s.message
      FROM probe_samples s JOIN json_each(?) r
        ON s.monitor_id = json_extract(r.value,'$.monitor_id') AND s.time = json_extract(r.value,'$.time')
      WHERE s.probe_id = ?
      ON CONFLICT(probe_id,monitor_id) DO UPDATE SET time=excluded.time, up=excluded.up,
      latency_ms=excluded.latency_ms, stage=excluded.stage, code=excluded.code, message=excluded.message
      WHERE excluded.time > probe_latest.time`
    ).bind(payload, probeId),
    // Apply differences against the old rollups before replacing them. Replays contribute zero.
    env.UPTIMEFLARE_D1.prepare(
      `${affected}, fresh AS (
      SELECT s.probe_id,s.monitor_id,a.time,COUNT(*) checks,SUM(1-s.up) failures,SUM(s.latency_ms) latency_sum
      FROM affected a JOIN probe_samples s ON s.probe_id=? AND s.monitor_id=a.monitor_id
        AND s.time>=a.time AND s.time<a.time+300 GROUP BY s.probe_id,s.monitor_id,a.time
    ), delta AS (
      SELECT n.probe_id,n.monitor_id,SUM(n.checks-COALESCE(b.checks,0)) checks,
        SUM(n.failures-COALESCE(b.failures,0)) failures,SUM(n.latency_sum-COALESCE(b.latency_sum,0)) latency_sum
      FROM fresh n LEFT JOIN probe_buckets b ON b.probe_id=n.probe_id AND b.monitor_id=n.monitor_id AND b.time=n.time
      GROUP BY n.probe_id,n.monitor_id
    ) INSERT INTO probe_totals (probe_id,monitor_id,checks,failures,latency_sum)
      SELECT probe_id,monitor_id,checks,failures,latency_sum FROM delta WHERE 1
      ON CONFLICT(probe_id,monitor_id) DO UPDATE SET checks=probe_totals.checks+excluded.checks,
        failures=probe_totals.failures+excluded.failures,latency_sum=probe_totals.latency_sum+excluded.latency_sum`
    ).bind(payload, probeId),
    env.UPTIMEFLARE_D1.prepare(
      `${affected}, fresh AS (
      SELECT s.probe_id,s.monitor_id,a.time,s.stage,COUNT(*) failures
      FROM affected a JOIN probe_samples s ON s.probe_id=? AND s.monitor_id=a.monitor_id
        AND s.time>=a.time AND s.time<a.time+300 WHERE s.up=0 GROUP BY s.probe_id,s.monitor_id,a.time,s.stage
    ), delta AS (
      SELECT n.probe_id,n.monitor_id,n.stage,SUM(n.failures-COALESCE(b.failures,0)) failures
      FROM fresh n LEFT JOIN probe_bucket_stages b ON b.probe_id=n.probe_id AND b.monitor_id=n.monitor_id
        AND b.time=n.time AND b.stage=n.stage GROUP BY n.probe_id,n.monitor_id,n.stage
    ) INSERT INTO probe_stage_totals (probe_id,monitor_id,stage,failures)
      SELECT probe_id,monitor_id,stage,failures FROM delta WHERE 1
      ON CONFLICT(probe_id,monitor_id,stage) DO UPDATE SET failures=probe_stage_totals.failures+excluded.failures`
    ).bind(payload, probeId),
    env.UPTIMEFLARE_D1.prepare(
      `${affected}
      INSERT INTO probe_buckets (probe_id,monitor_id,time,checks,failures,latency_sum)
      SELECT s.probe_id,s.monitor_id,a.time,COUNT(*),SUM(1-s.up),SUM(s.latency_ms)
      FROM affected a JOIN probe_samples s ON s.probe_id=? AND s.monitor_id=a.monitor_id
        AND s.time>=a.time AND s.time<a.time+300 GROUP BY s.probe_id,s.monitor_id,a.time
      ON CONFLICT(probe_id,monitor_id,time) DO UPDATE SET checks=excluded.checks,
        failures=excluded.failures,latency_sum=excluded.latency_sum`
    ).bind(payload, probeId),
    env.UPTIMEFLARE_D1.prepare(
      `${affected}
      INSERT INTO probe_bucket_stages (probe_id,monitor_id,time,stage,failures)
      SELECT s.probe_id,s.monitor_id,a.time,s.stage,COUNT(*)
      FROM affected a JOIN probe_samples s ON s.probe_id=? AND s.monitor_id=a.monitor_id
        AND s.time>=a.time AND s.time<a.time+300 WHERE s.up=0
      GROUP BY s.probe_id,s.monitor_id,a.time,s.stage
      ON CONFLICT(probe_id,monitor_id,time,stage) DO UPDATE SET failures=excluded.failures`
    ).bind(payload, probeId),
  ]
  // D1 batches run atomically. No ACK is returned before all samples and summaries are durable.
  const response = await env.UPTIMEFLARE_D1.batch([...statements, ...completionStatements])
  if (response.some((item) => !item.success)) throw new Error('Probe persistence failed')
}

/** The same authenticated endpoints are available on the Worker and the Pages origin. */
export async function handleProbeRequest(
  request: Request,
  env: ProbeEnv,
  monitors: MonitorTarget[],
  network?: ProbeNetwork
): Promise<Response> {
  try {
    const pathname = new URL(request.url).pathname
    const expectedMethod =
      pathname === '/api/probes/config' ? 'GET' : pathname === '/api/probes/ingest' ? 'POST' : ''
    if (!expectedMethod) return json({ error: 'Not found' }, 404)
    if (request.method !== expectedMethod)
      return new Response(null, { status: 405, headers: { Allow: expectedMethod } })
    const probeId = authenticate(request, env)
    const assigned = assignedMonitors(monitors, probeId)
    if (expectedMethod === 'GET') {
      try {
        await recordProbeNetwork(env, probeId, network)
      } catch {
        // Automatic labels are optional; their storage must not prevent probe startup.
        console.error('Probe network label update failed')
      }
      return json({
        version: 1,
        probe_id: probeId,
        monitors: assigned.map((monitor) => ({
          id: monitor.id,
          method: monitor.method,
          target: monitor.target,
          intervalSeconds: getMonitorIntervalSeconds(monitor),
          timeout: monitor.timeout ?? DEFAULT_MONITOR_TIMEOUT_MS,
          ...(monitor.headers && {
            headers: Object.fromEntries(
              Object.entries(monitor.headers).map(([key, value]) => [key, String(value)])
            ),
          }),
          ...(monitor.body !== undefined && { body: monitor.body }),
          ...(monitor.expectedCodes && { expectedCodes: monitor.expectedCodes }),
          ...(monitor.responseKeyword && { responseKeyword: monitor.responseKeyword }),
          ...(monitor.responseForbiddenKeyword && {
            responseForbiddenKeyword: monitor.responseForbiddenKeyword,
          }),
        })),
      })
    }
    const batch = validateBatch(await readBatch(request), assigned, Math.floor(Date.now() / 1000))
    await persistBatch(env, probeId, batch.results)
    return json({ batch_id: batch.batch_id, accepted: batch.results.length })
  } catch (error) {
    if (error instanceof ProbeRequestError) return json({ error: error.message }, error.status)
    console.error('Probe ingestion storage failure')
    return json({ error: 'Probe storage is temporarily unavailable; retry the same batch' }, 503)
  }
}

/** Bound deletion work per scheduled tick; old acknowledged offline backlog also expires here. */
export async function cleanupProbeResults(
  env: ProbeEnv,
  now = Math.floor(Date.now() / 1000)
): Promise<void> {
  const cutoff = now - RETENTION_SECONDS
  const expiredBuckets =
    'SELECT probe_id,monitor_id,time FROM probe_buckets WHERE time<? ORDER BY time,probe_id,monitor_id LIMIT 1000'
  // Remove stage counters from exactly the same bounded bucket set (at most seven stages per bucket).
  const expiredStages = `SELECT probe_id,monitor_id,time,stage FROM probe_bucket_stages WHERE (probe_id,monitor_id,time) IN (${expiredBuckets})`
  await env.UPTIMEFLARE_D1.batch([
    env.UPTIMEFLARE_D1.prepare(
      `WITH expired AS (${expiredBuckets}), delta AS (
      SELECT b.probe_id,b.monitor_id,SUM(b.checks) checks,SUM(b.failures) failures,SUM(b.latency_sum) latency_sum
      FROM probe_buckets b JOIN expired e ON b.probe_id=e.probe_id AND b.monitor_id=e.monitor_id AND b.time=e.time
      GROUP BY b.probe_id,b.monitor_id
    ) INSERT INTO probe_totals (probe_id,monitor_id,checks,failures,latency_sum)
      SELECT probe_id,monitor_id,-checks,-failures,-latency_sum FROM delta WHERE 1
      ON CONFLICT(probe_id,monitor_id) DO UPDATE SET checks=probe_totals.checks+excluded.checks,
        failures=probe_totals.failures+excluded.failures,latency_sum=probe_totals.latency_sum+excluded.latency_sum`
    ).bind(cutoff),
    env.UPTIMEFLARE_D1.prepare(
      `WITH expired AS (${expiredStages}), delta AS (
      SELECT b.probe_id,b.monitor_id,b.stage,SUM(b.failures) failures
      FROM probe_bucket_stages b JOIN expired e ON b.probe_id=e.probe_id AND b.monitor_id=e.monitor_id AND b.time=e.time AND b.stage=e.stage
      GROUP BY b.probe_id,b.monitor_id,b.stage
    ) INSERT INTO probe_stage_totals (probe_id,monitor_id,stage,failures)
      SELECT probe_id,monitor_id,stage,-failures FROM delta WHERE 1
      ON CONFLICT(probe_id,monitor_id,stage) DO UPDATE SET failures=probe_stage_totals.failures+excluded.failures`
    ).bind(cutoff),
    env.UPTIMEFLARE_D1.prepare(
      `DELETE FROM probe_samples WHERE (probe_id,monitor_id,time) IN
      (SELECT probe_id,monitor_id,time FROM probe_samples WHERE time<? ORDER BY time,probe_id,monitor_id LIMIT 5000)`
    ).bind(cutoff),
    env.UPTIMEFLARE_D1.prepare(
      `DELETE FROM probe_bucket_stages WHERE (probe_id,monitor_id,time,stage) IN (${expiredStages})`
    ).bind(cutoff),
    env.UPTIMEFLARE_D1.prepare(
      `DELETE FROM probe_buckets WHERE (probe_id,monitor_id,time) IN (${expiredBuckets})`
    ).bind(cutoff),
  ])
}

type Latest = {
  probe_id: string
  monitor_id: string
  time: number
  up: number
  latency_ms: number
  stage: string
  code: string
  message: string
}
type Bucket = {
  probe_id: string
  monitor_id: string
  time: number
  checks: number
  failures: number
  latency_sum: number
}

export async function getProbeSummaries(
  env: ProbeEnv,
  monitors: MonitorTarget[],
  definitions: ProbeDefinition[] = [],
  now = Math.floor(Date.now() / 1000)
): Promise<Record<string, ProbeMonitorSummary>> {
  const external = monitors.filter((m) => m.probes?.length)
  if (!external.length) return {}
  if (
    external.length > 100 ||
    definitions.length > 33 ||
    external.reduce((total, m) => total + (m.probes?.length || 0), 0) > 64 ||
    external.some((m) => (m.probes?.length || 0) > 33)
  ) {
    throw new Error('Probe display configuration exceeds limits')
  }
  // Scope reads to current assignments; removed probe identities cannot inflate page queries.
  const assignments = JSON.stringify(
    external.flatMap((m) => m.probes!.map((id) => ({ probe_id: id, monitor_id: m.id })))
  )
  const allowedPairs = `SELECT json_extract(value,'$.probe_id'),json_extract(value,'$.monitor_id') FROM json_each(?)`
  const scope = `(probe_id,monitor_id) IN (${allowedPairs})`
  const latestScope = `(l.probe_id,l.monitor_id) IN (${allowedPairs})`
  const [latestData, totalsData, historyData, stagesData, failuresData] =
    await env.UPTIMEFLARE_D1.batch([
      env.UPTIMEFLARE_D1.prepare(`SELECT * FROM probe_latest WHERE ${scope}`).bind(assignments),
      env.UPTIMEFLARE_D1.prepare(`SELECT * FROM probe_totals WHERE ${scope}`).bind(assignments),
      env.UPTIMEFLARE_D1.prepare(
        `SELECT * FROM probe_buckets WHERE ${scope} AND time>=? AND time<=? ORDER BY time`
      ).bind(assignments, Math.floor((now - 12 * 60 * 60) / 300) * 300, now),
      env.UPTIMEFLARE_D1.prepare(
        `SELECT * FROM probe_stage_totals WHERE ${scope} AND failures>0`
      ).bind(assignments),
      // Index-assisted correlated LIMIT avoids ranking every retained failed sample.
      env.UPTIMEFLARE_D1.prepare(
        `SELECT s.* FROM probe_latest l JOIN probe_samples s ON
      s.probe_id=l.probe_id AND s.monitor_id=l.monitor_id AND s.time IN
      (SELECT f.time FROM probe_samples f WHERE f.probe_id=l.probe_id AND f.monitor_id=l.monitor_id
        AND f.up=0 AND f.time>=? ORDER BY f.time DESC LIMIT 100)
      WHERE ${latestScope} AND s.up=0 ORDER BY s.time DESC`
      ).bind(now - RETENTION_SECONDS, assignments),
    ])
  if ([latestData, totalsData, historyData, stagesData, failuresData].some((r) => !r.success)) {
    throw new Error('Unable to load probe summaries')
  }
  const key = (row: { monitor_id: string; probe_id: string }) =>
    `${row.monitor_id}\0${row.probe_id}`
  const latestMap = new Map((latestData.results as Latest[]).map((row) => [key(row), row]))
  const totalsMap = new Map((totalsData.results as Bucket[]).map((row) => [key(row), row]))
  const histories = new Map<string, ProbeSummary['history']>()
  for (const row of historyData.results as Bucket[]) {
    const values = histories.get(key(row)) || []
    values.push({
      time: row.time,
      checks: row.checks,
      failures: row.failures,
      avgLatencyMs: row.checks ? row.latency_sum / row.checks : null,
    })
    histories.set(key(row), values)
  }
  const stages = new Map<string, Record<string, number>>()
  for (const row of stagesData.results as (Latest & { failures: number })[]) {
    const values = stages.get(key(row)) || {}
    values[row.stage] = row.failures
    stages.set(key(row), values)
  }
  const failures = new Map<string, ProbeSummary['recentFailures']>()
  for (const row of failuresData.results as Latest[]) {
    const values = failures.get(key(row)) || []
    values.push({ time: row.time, stage: row.stage, code: row.code, message: row.message })
    failures.set(key(row), values)
  }
  const labels = new Map(definitions.map((probe) => [probe.id, probe]))
  const summaries: Record<string, ProbeMonitorSummary> = {}
  for (const monitor of external) {
    const probes = monitor.probes!.map((id, index) => {
      const lookup = `${monitor.id}\0${id}`
      const latest = latestMap.get(lookup)
      const totals = totalsMap.get(lookup)
      const definition = labels.get(id)
      const stale = !latest || latest.time < now - getMonitorStaleAfterSeconds(monitor)
      const status = stale ? 'unknown' : latest!.up ? 'up' : 'down'
      const probe: ProbeSummary = {
        id,
        name:
          definition?.name ||
          definition?.defaultName ||
          (id === CLOUDFLARE_PROBE_ID ? 'Cloudflare' : `探针 ${index + 1}`),
        location: definition?.location || definition?.defaultLocation || undefined,
        status,
        stale,
        latest: latest?.time ?? null,
        latencyMs: latest?.latency_ms ?? null,
        stage: stale ? 'probe' : latest?.stage || undefined,
        code: stale ? (latest ? 'stale' : 'no_data') : latest?.code || undefined,
        message: stale
          ? latest
            ? 'Probe has not reported a recent result'
            : 'Waiting for the first probe result'
          : latest?.message || undefined,
        checks: totals?.checks ?? 0,
        failures: totals?.failures ?? 0,
        avgLatencyMs: totals?.checks ? totals.latency_sum / totals.checks : null,
        failureStages: stages.get(lookup) || {},
        history: histories.get(lookup) || [],
        recentFailures: failures.get(lookup) || [],
      }
      return probe
    })
    const up = probes.filter((p) => p.status === 'up').length
    const down = probes.filter((p) => p.status === 'down').length
    const unknown = probes.length - up - down
    const latestTimes = probes.flatMap((p) => (p.latest === null ? [] : [p.latest]))
    summaries[monitor.id] = {
      monitorId: monitor.id,
      status: aggregateStatus(up, down, unknown),
      up,
      down,
      unknown,
      total: probes.length,
      latest: latestTimes.length ? Math.max(...latestTimes) : null,
      probes,
    }
  }
  return summaries
}
