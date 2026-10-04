import type { PublicDashboardSnapshot } from '../types/public-dashboard'
import type { ProbeMonitorSummary, ProbeSummary } from '../types/probes'
/** Compact public projection only. Labels are shared and histories never enter this wire format. */
export function encodePublicWire(snapshot: PublicDashboardSnapshot) {
  const indexes = new Map(snapshot.monitors.map((monitor, index) => [monitor.id, index])),
    labels: unknown[][] = [],
    labelIndexes = new Map<string, number>()
  for (const summary of Object.values(snapshot.probeSummaries))
    for (const probe of summary.probes)
      if (!labelIndexes.has(probe.id)) {
        labelIndexes.set(probe.id, labels.length)
        labels.push([probe.id, probe.name, probe.location ?? null])
      }
  for (const monitor of snapshot.monitors)
    for (const id of monitor.probes ?? [])
      if (!labelIndexes.has(id)) {
        labelIndexes.set(id, labels.length)
        labels.push([id, id === 'cloudflare' ? 'Cloudflare' : '探针', null])
      }
  return {
    version: 1,
    wire: 2,
    generatedAt: snapshot.generatedAt,
    configRevision: snapshot.configRevision,
    complete: snapshot.complete,
    labels,
    monitors: snapshot.monitors.map((m) => [
      m.id,
      m.name,
      m.intervalSeconds,
      m.paused ? 1 : 0,
      (m.probes ?? []).map((id) => labelIndexes.get(id)),
      m.tooltip ?? null,
      m.statusPageLink ?? null,
      m.hideLatencyChart ? 1 : 0,
    ]),
    page: {
      ...snapshot.page,
      group: Object.fromEntries(
        Object.entries(snapshot.page.group ?? {}).map(([name, ids]) => [
          name,
          ids.map((id) => indexes.get(id)).filter((index) => index !== undefined),
        ])
      ),
    },
    maintenances: snapshot.maintenances,
    summaries: snapshot.monitors.map((m) => {
      const summary = snapshot.probeSummaries[m.id]
      return summary
        ? [
            summary.probes.map((p) => [
              labelIndexes.get(p.id),
              p.status,
              p.stale ? 1 : 0,
              p.latest,
              p.latencyMs,
              p.stage ?? null,
              p.code ?? null,
              p.checks,
              p.failures,
              p.uptimePercent,
              p.certificateExpiresAt ?? null,
              p.certificateDaysRemaining ?? null,
              p.icmpLatencyMs ?? null,
            ]),
            summary.uptimePercent,
          ]
        : null
    }),
    compactedStateStr: snapshot.compactedStateStr,
  }
}
export function decodePublicWire(raw: any): PublicDashboardSnapshot {
  if (raw?.wire !== 2) return raw as PublicDashboardSnapshot
  if (
    !Array.isArray(raw.monitors) ||
    !Array.isArray(raw.labels) ||
    !Array.isArray(raw.summaries) ||
    raw.monitors.length > 500 ||
    raw.labels.length > 33
  )
    throw new Error('Invalid public wire')
  const monitors = raw.monitors.map((m: any) => ({
    id: m[0],
    name: m[1],
    intervalSeconds: m[2],
    paused: !!m[3],
    method: '',
    target: '',
    ...(m[4]?.length && { probes: m[4].map((i: number) => raw.labels[i]?.[0]) }),
    ...(m[5] && { tooltip: m[5] }),
    ...(m[6] && { statusPageLink: m[6] }),
    hideLatencyChart: !!m[7],
  }))
  const probeSummaries: Record<string, ProbeMonitorSummary> = {}
  for (let index = 0; index < monitors.length; index++) {
    const monitor = monitors[index],
      entry = raw.summaries[index]
    if (!monitor.probes?.length) continue
    const probes: ProbeSummary[] = (entry?.[0] ?? []).map((p: any) => ({
      id: raw.labels[p[0]][0],
      name: raw.labels[p[0]][1],
      location: raw.labels[p[0]][2] ?? undefined,
      status: p[1],
      stale: !!p[2],
      latest: p[3],
      latencyMs: p[4],
      stage: p[5] ?? undefined,
      code: p[6] ?? undefined,
      checks: p[7] ?? 0,
      failures: p[8] ?? 0,
      uptimePercent: p[9] ?? null,
      ...(p[10] !== null && { certificateExpiresAt: p[10] }),
      ...(p[11] !== null && { certificateDaysRemaining: p[11] }),
      ...(p[12] !== null && { icmpLatencyMs: p[12] }),
      avgLatencyMs: null,
      failureStages: {},
      history: [],
      dailyHistory: [],
      recentFailures: [],
      retainedFrom: null,
    }))
    const up = probes.filter((p) => p.status === 'up').length,
      down = probes.filter((p) => p.status === 'down').length
    probeSummaries[monitor.id] = {
      monitorId: monitor.id,
      historyLoaded: false,
      paused: monitor.paused,
      status: monitor.paused
        ? 'paused'
        : up && down
        ? 'degraded'
        : up
        ? 'up'
        : down
        ? 'down'
        : 'unknown',
      up,
      down,
      unknown: probes.length - up - down,
      total: monitor.probes.length,
      latest: probes.reduce<number | null>(
        (value, p) => (p.latest === null ? value : Math.max(value ?? 0, p.latest)),
        null
      ),
      dailyHistory: [],
      uptimePercent: entry?.[1] ?? null,
      retainedFrom: null,
      probes,
    }
  }
  return {
    ...raw,
    monitors,
    page: {
      ...raw.page,
      group: Object.fromEntries(
        Object.entries(raw.page?.group ?? {}).map(([name, indices]) => [
          name,
          (indices as number[]).map((index) => monitors[index]?.id).filter(Boolean),
        ])
      ),
    },
    probeSummaries,
  }
}
export function utf8Prefix(value: string, maximum: number) {
  let output = '',
    used = 0
  for (const character of value) {
    const bytes = new TextEncoder().encode(character).byteLength
    if (used + bytes > maximum) break
    output += character
    used += bytes
  }
  return output
}
