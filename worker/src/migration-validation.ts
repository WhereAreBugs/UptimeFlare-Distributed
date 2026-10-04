import type { ProbeEnv } from './probes'
import type { MigrationPlan } from './migration-v2'
import { CompactedMonitorStateWrapper } from './store'

const stamp = (v: unknown): v is number =>
  Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 4102444800
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b)
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v))
        .join(',') +
      '}'
    )
  return JSON.stringify(value)
}
function normalized(rows: unknown[][]) {
  return rows
    .map((row) =>
      canonical(
        row.map((v) =>
          typeof v === 'string' && (v.startsWith('[') || v.startsWith('{')) ? JSON.parse(v) : v
        )
      )
    )
    .sort()
}

/** Validate the old format independently of the exported plan before touching destination rows. */
export async function validateMigrationSemantics(env: ProbeEnv, plan: MigrationPlan) {
  if (new TextEncoder().encode(JSON.stringify(plan)).byteLength > 16 * 1024 * 1024)
    throw new Error('Migration plan byte budget exceeded')
  const raw =
    plan.sourceValue === null
      ? { lastUpdate: 0, incident: {}, latency: {} }
      : JSON.parse(plan.sourceValue)
  if (
    !raw ||
    !stamp(raw.lastUpdate) ||
    !raw.incident ||
    !raw.latency ||
    Object.keys(raw).some(
      (k) => !['lastUpdate', 'overallUp', 'overallDown', 'incident', 'latency'].includes(k)
    )
  )
    throw new Error('Unknown legacy state shape')
  const state: {
    lastUpdate: number
    incident: Record<string, any[]>
    latency: Record<string, any[]>
  } = { lastUpdate: raw.lastUpdate, incident: {}, latency: {} }
  for (const [id, input] of Object.entries(raw.incident) as [string, any][]) {
    const values = Array.isArray(input)
      ? input
      : input?.start?.map((start: unknown, i: number) => ({
          start,
          end: input.end?.[i],
          error: input.error?.[i],
        }))
    if (
      !Array.isArray(values) ||
      (!Array.isArray(input) &&
        (input.start.length !== input.end?.length || input.start.length !== input.error?.length))
    )
      throw new Error('Invalid incident columns')
    let previousEnd = -1
    for (const e of values) {
      if (
        !e ||
        !Array.isArray(e.start) ||
        !e.start.length ||
        !Array.isArray(e.error) ||
        e.error.length !== e.start.length ||
        e.error.some((v: unknown) => typeof v !== 'string') ||
        e.start.some(
          (v: unknown, i: number) => !stamp(v) || (i && (v as number) <= e.start[i - 1])
        ) ||
        e.start[0] < previousEnd ||
        (e.end !== null && (!stamp(e.end) || e.end < e.start.at(-1)))
      )
        throw new Error('Invalid incident relationship')
      previousEnd = e.end ?? Infinity
    }
    state.incident[id] = values
  }
  for (const [id, input] of Object.entries(raw.latency) as [string, any][]) {
    let values = input
    if (!Array.isArray(input)) {
      const hex = (v: unknown) => typeof v === 'string' && /^(?:[0-9a-fA-F]{2})*$/.test(v)
      const count = input?.time?.length / 8
      if (
        !hex(input?.time) ||
        !hex(input?.ping) ||
        input.time.length % 8 ||
        input.ping.length % 4 ||
        input.ping.length / 4 !== count ||
        !Array.isArray(input.loc?.c) ||
        !Array.isArray(input.loc?.v) ||
        input.loc.c.length !== input.loc.v.length ||
        input.loc.c.some((n: unknown) => !Number.isInteger(n) || (n as number) <= 0) ||
        input.loc.v.some((v: unknown) => typeof v !== 'string') ||
        input.loc.c.reduce((a: number, b: number) => a + b, 0) !== count
      )
        throw new Error('Invalid compressed arrays or location RLE')
      const decoder = new CompactedMonitorStateWrapper(
        JSON.stringify({ lastUpdate: raw.lastUpdate, incident: {}, latency: { [id]: input } })
      )
      values = decoder.uncompact().latency[id]
    }
    if (
      !Array.isArray(values) ||
      values.length > 100000 ||
      values.some(
        (s: any, i: number) =>
          !stamp(s.time) ||
          (i && s.time <= values[i - 1].time) ||
          typeof s.loc !== 'string' ||
          !Number.isFinite(s.ping) ||
          s.ping < 0 ||
          s.ping > 300000
      )
    )
      throw new Error('Invalid latency samples')
    state.latency[id] = values
  }
  const expected: Record<string, unknown[][]> = {
    native_hot: [],
    native_incidents: [],
    native_incident_reasons: [],
    native_latency_blocks: [],
  }
  for (const id of Array.from(
    new Set([...Object.keys(state.incident), ...Object.keys(state.latency)])
  ).sort()) {
    const samples = state.latency[id] ?? [],
      episodes = state.incident[id] ?? [],
      real = episodes.filter((e) => e.error[0] !== 'dummy'),
      last = samples[samples.length - 1],
      opened = real[real.length - 1]?.end === null ? real[real.length - 1] : undefined
    if (last)
      expected.native_hot.push([
        id,
        last.time,
        opened ? 0 : 1,
        last.ping,
        last.loc,
        opened?.error.at(-1) ?? '',
        opened?.start[0] ?? null,
        episodes[0]?.start[0] ?? samples[0].time,
        0,
      ])
    for (const e of real) {
      expected.native_incidents.push([id, e.start[0], e.end])
      e.start.forEach((t: number, i: number) =>
        expected.native_incident_reasons.push([id, e.start[0], t, e.error[i]])
      )
    }
    const windows = new Map<number, any[]>()
    for (const sample of samples) {
      const w = Math.floor(sample.time / 300) * 300
      windows.set(w, [...(windows.get(w) ?? []), sample])
    }
    for (const [w, values] of windows) {
      const value = JSON.stringify(values)
      if (new TextEncoder().encode(value).byteLength > 32768)
        throw new Error('Native block exceeds budget')
      expected.native_latency_blocks.push([id, w, value])
    }
  }
  for (const name of Object.keys(expected))
    if (!same(normalized(expected[name]), normalized(plan.tables[name])))
      throw new Error('Native migration semantics mismatch')
  const planned = new Map<string, string>(),
    failures: unknown[][] = []
  for (const [probe, window, chunk, value] of plan.tables.probe_result_blocks as [
    string,
    number,
    number,
    string,
  ][]) {
    if (
      typeof probe !== 'string' ||
      !stamp(window) ||
      window % 300 ||
      !Number.isInteger(chunk) ||
      chunk < 0 ||
      new TextEncoder().encode(value).byteLength > 32768
    )
      throw new Error('Invalid probe block')
    const samples = JSON.parse(value)
    if (!Array.isArray(samples) || !samples.length || samples.length > 40)
      throw new Error('Invalid probe samples')
    for (const s of samples) {
      if (
        typeof s.monitor_id !== 'string' ||
        !stamp(s.time) ||
        Math.floor(s.time / 300) * 300 !== window ||
        typeof s.up !== 'boolean' ||
        !Number.isFinite(s.latency_ms) ||
        s.latency_ms < 0
      )
        throw new Error('Invalid probe result')
      const key = JSON.stringify([probe, s.monitor_id, s.time])
      if (planned.has(key)) throw new Error('Duplicate migrated result')
      planned.set(key, canonical(s))
      if (!s.up) failures.push([probe, s.monitor_id, s.time, s.stage, s.code, s.message])
    }
  }
  if (!same(normalized(failures), normalized(plan.tables.probe_failure_events)))
    throw new Error('Failure index semantics mismatch')
  let count = 0
  for (let offset = 0; ; offset += 512) {
    const rows = await env.UPTIMEFLARE_D1.prepare(
      'SELECT s.*,d.details FROM probe_samples s LEFT JOIN probe_sample_details d USING(probe_id,monitor_id,time) ORDER BY probe_id,monitor_id,time LIMIT 512 OFFSET ?'
    )
      .bind(offset)
      .all<any>()
    if (!rows.success) throw new Error('Legacy probe validation failed')
    for (const r of rows.results) {
      const sample: any = {
        monitor_id: r.monitor_id,
        time: r.time,
        up: !!r.up,
        latency_ms: r.latency_ms,
        stage: r.stage,
        code: r.code,
        message: r.message,
      }
      const names: Record<string, string> = {
        certificateExpiresAt: 'certificate_expires_at',
        certificateDaysRemaining: 'certificate_days_remaining',
        icmpLatencyMs: 'icmp_latency_ms',
      }
      for (const [k, v] of Object.entries(JSON.parse(r.details ?? '{}'))) {
        if (!names[k]) throw new Error('Unknown sample metadata')
        sample[names[k]] = v
      }
      if (planned.get(JSON.stringify([r.probe_id, r.monitor_id, r.time])) !== canonical(sample))
        throw new Error('Probe migration semantics mismatch')
      count++
    }
    if (rows.results.length < 512) break
  }
  if (count !== planned.size) throw new Error('Probe migration completeness mismatch')
}
