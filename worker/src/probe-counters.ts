import type { ProbeEnv } from './probes'

const PREFIX = 'probe-counters:v1:'
const MAX_BYTES = 1024 * 1024
export type ProbeCounter = {
  checks: number
  failures: number
  latency_sum: number
  stages: Record<string, number>
}
type Document = { version: 1; monitors: Record<string, ProbeCounter> }
export type CounterDelta = {
  probe_id: string
  monitor_id: string
  checks: number
  failures: number
  latency_sum: number
}
export type StageDelta = { probe_id: string; monitor_id: string; stage: string; failures: number }
export const counterKey = (probe: string, monitor: string) => probe + '\0' + monitor

/** Existing documents remain authoritative even if the activation environment
 * variable is later omitted. There is no second set of counters to double-add. */
export async function loadProbeCounters(env: ProbeEnv, probeIds: string[]) {
  const ids = [...new Set(probeIds)]
  const documents = new Map<string, Document>()
  if (!ids.length) return documents
  const rows = await env.UPTIMEFLARE_D1.prepare(
    'SELECT key,value FROM uptimeflare WHERE key IN (SELECT value FROM json_each(?))'
  )
    .bind(JSON.stringify(ids.map((id) => PREFIX + id)))
    .all<{ key: string; value: string }>()
  if (!rows.success) throw new Error('Probe counter read failed')
  let totalBytes = 0
  for (const row of rows.results) {
    const bytes = new TextEncoder().encode(row.value).byteLength
    totalBytes += bytes
    if (bytes > MAX_BYTES || totalBytes > 8 * MAX_BYTES)
      throw new Error('Probe counter read budget exceeded')
    const document = JSON.parse(row.value) as Document
    if (document.version !== 1 || !document.monitors || Array.isArray(document.monitors))
      throw new Error('Unsupported probe counters')
    document.monitors = Object.assign(Object.create(null), document.monitors)
    for (const counter of Object.values(document.monitors)) {
      if (
        !counter ||
        !Number.isSafeInteger(counter.checks) ||
        counter.checks < 0 ||
        !Number.isSafeInteger(counter.failures) ||
        counter.failures < 0 ||
        counter.failures > counter.checks ||
        !Number.isFinite(counter.latency_sum) ||
        !counter.stages ||
        Array.isArray(counter.stages) ||
        Object.values(counter.stages).some((value) => !Number.isSafeInteger(value) || value < 0)
      )
        throw new Error('Invalid probe counter document')
      counter.stages = Object.assign(Object.create(null), counter.stages)
    }
    documents.set(row.key.slice(PREFIX.length), document)
  }
  return documents
}

/** Prepare one durable document per probe instead of one total/stage row per
 * target. Missing entries are hydrated by indexed legacy lookups exactly once. */
export async function prepareProbeCounters(
  env: ProbeEnv,
  deltas: CounterDelta[],
  stageDeltas: StageDelta[],
  guard: string,
  hydrate = true
) {
  const documents = await loadProbeCounters(
      env,
      deltas.map((delta) => delta.probe_id)
    ),
    active = new Set<string>()
  for (const delta of deltas) {
    if (!documents.has(delta.probe_id) && hydrate && env.PACKED_PROBE_COUNTERS === '1')
      documents.set(delta.probe_id, { version: 1, monitors: Object.create(null) })
    if (
      documents.has(delta.probe_id) &&
      (hydrate || documents.get(delta.probe_id)!.monitors[delta.monitor_id])
    )
      active.add(counterKey(delta.probe_id, delta.monitor_id))
  }
  const missing = hydrate
    ? deltas.filter(
        (delta) =>
          active.has(counterKey(delta.probe_id, delta.monitor_id)) &&
          !documents.get(delta.probe_id)!.monitors[delta.monitor_id]
      )
    : []
  if (missing.length) {
    const pairs = JSON.stringify(missing.map((delta) => [delta.probe_id, delta.monitor_id])),
      scope = `(probe_id,monitor_id) IN (SELECT json_extract(value,'$[0]'),json_extract(value,'$[1]') FROM json_each(?))`,
      [totals, stages] = await env.UPTIMEFLARE_D1.batch([
        env.UPTIMEFLARE_D1.prepare(`SELECT * FROM probe_totals WHERE ${scope}`).bind(pairs),
        env.UPTIMEFLARE_D1.prepare(`SELECT * FROM probe_stage_totals WHERE ${scope}`).bind(pairs),
      ])
    if (!totals.success || !stages.success) throw new Error('Probe counter hydration failed')
    for (const delta of missing)
      documents.get(delta.probe_id)!.monitors[delta.monitor_id] = {
        checks: 0,
        failures: 0,
        latency_sum: 0,
        stages: Object.create(null),
      }
    for (const row of totals.results as CounterDelta[])
      Object.assign(documents.get(row.probe_id)!.monitors[row.monitor_id], {
        checks: row.checks,
        failures: row.failures,
        latency_sum: row.latency_sum,
      })
    for (const row of stages.results as StageDelta[])
      documents.get(row.probe_id)!.monitors[row.monitor_id].stages[row.stage] = row.failures
  }
  for (const delta of deltas) {
    if (!active.has(counterKey(delta.probe_id, delta.monitor_id))) continue
    const counter = documents.get(delta.probe_id)!.monitors[delta.monitor_id]
    counter.checks += delta.checks
    counter.failures += delta.failures
    counter.latency_sum += delta.latency_sum
    if (counter.checks < 0 || counter.failures < 0 || counter.failures > counter.checks)
      throw new Error('Invalid probe counter delta')
    if (!counter.checks) counter.latency_sum = 0
  }
  for (const delta of stageDeltas) {
    if (!active.has(counterKey(delta.probe_id, delta.monitor_id))) continue
    const counter = documents.get(delta.probe_id)!.monitors[delta.monitor_id],
      next = (counter.stages[delta.stage] ?? 0) + delta.failures
    if (next < 0) throw new Error('Invalid probe stage delta')
    if (next) counter.stages[delta.stage] = next
    else delete counter.stages[delta.stage]
  }
  const changed = [
      ...new Set(
        deltas
          .filter((delta) => active.has(counterKey(delta.probe_id, delta.monitor_id)))
          .map((delta) => delta.probe_id)
      ),
    ],
    statements = changed.map((probeId) => {
      const value = JSON.stringify(documents.get(probeId))
      if (new TextEncoder().encode(value).byteLength > MAX_BYTES)
        throw new Error('Probe counter document exceeds budget')
      return env.UPTIMEFLARE_D1.prepare(
        `INSERT INTO uptimeflare(key,value) SELECT ?,? WHERE (${guard}) ON CONFLICT(key) DO UPDATE SET value=excluded.value`
      ).bind(PREFIX + probeId, value)
    })
  return { statements, active }
}
