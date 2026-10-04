import type {
  MaintenanceConfig,
  MonitorStateCompacted,
  MonitorTarget,
  PageConfig,
  WorkerConfig,
} from '../../types/config'
import type { ProbeMonitorSummary, ProbeSummary } from '../../types/probes'
import type { PublicDashboard, PublicDashboardSnapshot } from '../../types/public-dashboard'
import { PUBLIC_SNAPSHOT_MAX_AGE_SECONDS } from '../../types/public-dashboard'
import { getPresentationSettings } from '../../util/maintenance'
import { getMonitorIntervalSeconds } from '../../util/monitor-settings'
import { aggregateStatus, refreshProbeSummary } from '../../util/probe-status'
import { getProbeDashboardSummaries, type ProbeEnv } from './probes'
import { getRuntimeConfig } from './settings'
import { getPublicNativeState } from './store'
import { parseNativeDiagnostic } from './diagnostics'

export const PUBLIC_DASHBOARD_KEY = 'public-dashboard:v1'
export const PUBLIC_CONFIGURATION_KEY = 'public-dashboard-config:v1'
export { PUBLIC_SNAPSHOT_MAX_AGE_SECONDS } from '../../types/public-dashboard'
const MAX_SNAPSHOT_BYTES = 256 * 1024
const CACHE_URL = 'https://uptimeflare-public-cache.invalid/dashboard-v1'
const RECOVERY_CACHE_URL = CACHE_URL + '/public-dashboard-recovery.json'
export type PublicDashboardEnv = ProbeEnv & {
  UPTIMEFLARE_PUBLIC_KV?: KVNamespace
  ASSETS?: Fetcher
}
const record = (value: unknown): Record<string, any> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, any>) : {}
const string = (value: unknown, limit = 4096): string | undefined =>
  typeof value === 'string' ? value.slice(0, limit) : undefined
const number = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/** Allowlisting is applied on both publication and consumption, including manually seeded snapshots. */
export function publicMonitors(source: unknown): MonitorTarget[] {
  if (!Array.isArray(source) || source.length > 100) throw new Error('Invalid public monitor list')
  const ids = new Set<string>()
  return source.map((raw) => {
    const value = record(raw),
      id = string(value.id, 128),
      name = string(value.name, 200)
    if (!id || !name || ids.has(id)) throw new Error('Invalid public monitor identity')
    ids.add(id)
    return {
      id,
      name,
      method: '',
      target: '',
      intervalSeconds:
        Number.isInteger(value.intervalSeconds) &&
        value.intervalSeconds >= 60 &&
        value.intervalSeconds <= 86400
          ? value.intervalSeconds
          : getMonitorIntervalSeconds({}),
      ...(value.paused === true && { paused: true }),
      ...(typeof value.tooltip === 'string' && { tooltip: string(value.tooltip) }),
      ...(typeof value.statusPageLink === 'string' && {
        statusPageLink: string(value.statusPageLink),
      }),
      ...(typeof value.hideLatencyChart === 'boolean' && {
        hideLatencyChart: value.hideLatencyChart,
      }),
      ...(Array.isArray(value.probes) &&
        value.probes.length && {
          probes: Array.from(
            new Set(value.probes.filter((id: unknown) => typeof id === 'string').slice(0, 33))
          ) as string[],
        }),
    }
  })
}
function publicPage(source: unknown, ids: Set<string>): PageConfig {
  const value = record(source),
    result: PageConfig = {}
  for (const key of ['title', 'logo', 'favicon', 'customFooter'] as const) {
    const text = string(value[key], key === 'customFooter' ? 16384 : 4096)
    if (text !== undefined) result[key] = text
  }
  if (Array.isArray(value.links))
    result.links = value.links.slice(0, 50).flatMap((raw) => {
      const link = record(raw)
      return typeof link.link === 'string' && typeof link.label === 'string'
        ? [
            {
              link: string(link.link)!,
              label: string(link.label, 200)!,
              ...(link.highlight === true && { highlight: true }),
            },
          ]
        : []
    })
  if (value.group && typeof value.group === 'object')
    result.group = Object.fromEntries(
      Object.entries(record(value.group))
        .slice(0, 50)
        .map(([name, members]) => [
          name.slice(0, 200),
          Array.isArray(members)
            ? members.filter((id) => typeof id === 'string' && ids.has(id)).slice(0, 100)
            : [],
        ])
    )
  const color = string(record(value.maintenances).upcomingColor, 100)
  if (color !== undefined) result.maintenances = { upcomingColor: color }
  return result
}
function publicMaintenances(source: unknown, ids: Set<string>): MaintenanceConfig[] {
  if (!Array.isArray(source)) return []
  return source.slice(0, 100).flatMap((raw) => {
    const value = record(raw)
    if (typeof value.body !== 'string' || !['string', 'number'].includes(typeof value.start))
      return []
    const repeat = record(value.repeat)
    if (
      Array.isArray(value.monitors) &&
      value.monitors.length &&
      !value.monitors.some((id: unknown) => typeof id === 'string' && ids.has(id))
    )
      return []
    return [
      {
        body: string(value.body)!,
        start: value.start,
        ...(['string', 'number'].includes(typeof value.end) && { end: value.end }),
        ...(typeof value.id === 'string' && { id: string(value.id, 128) }),
        ...(typeof value.title === 'string' && { title: string(value.title, 200) }),
        ...(typeof value.color === 'string' && { color: string(value.color, 100) }),
        ...(Array.isArray(value.monitors) && {
          monitors: value.monitors
            .filter((id: unknown) => typeof id === 'string' && ids.has(id))
            .slice(0, 100),
        }),
        ...(['daily', 'weekly', 'monthly'].includes(repeat.frequency) &&
          typeof repeat.timeZone === 'string' && {
            repeat: { frequency: repeat.frequency, timeZone: string(repeat.timeZone, 100)! },
          }),
      } as MaintenanceConfig,
    ]
  })
}
function safeProbe(id: string, index: number, raw: unknown): ProbeSummary {
  const value = record(raw)
  return {
    id,
    name: string(value.name, 200) || (id === 'cloudflare' ? 'Cloudflare' : `探针 ${index + 1}`),
    ...(typeof value.location === 'string' && { location: string(value.location, 200) }),
    status: value.status === 'up' || value.status === 'down' ? value.status : 'unknown',
    stale: value.stale !== false,
    latest: number(value.latest),
    latencyMs: number(value.latencyMs),
    ...(typeof value.stage === 'string' && { stage: string(value.stage, 32) }),
    ...(typeof value.code === 'string' && { code: string(value.code, 64) }),
    ...(number(value.certificateExpiresAt) !== null && {
      certificateExpiresAt: number(value.certificateExpiresAt)!,
    }),
    ...(number(value.certificateDaysRemaining) !== null && {
      certificateDaysRemaining: number(value.certificateDaysRemaining)!,
    }),
    ...(number(value.icmpLatencyMs) !== null && { icmpLatencyMs: number(value.icmpLatencyMs)! }),
    checks: Math.max(0, number(value.checks) ?? 0),
    failures: Math.max(0, number(value.failures) ?? 0),
    avgLatencyMs: null,
    failureStages: {},
    history: [],
    dailyHistory: [],
    recentFailures: [],
    uptimePercent: number(value.uptimePercent),
    retainedFrom: null,
  }
}
function safeSummaries(
  monitors: MonitorTarget[],
  raw: unknown
): Record<string, ProbeMonitorSummary> {
  const source = record(raw)
  return Object.fromEntries(
    monitors
      .filter((monitor) => monitor.probes?.length)
      .map((monitor) => {
        const value = record(source[monitor.id])
        const prior = new Map<string, unknown>(
          (Array.isArray(value.probes) ? value.probes : []).map((raw) => [record(raw).id, raw])
        )
        const probes = monitor.paused
          ? []
          : monitor.probes!.map((id, index) => safeProbe(id, index, prior.get(id)))
        const up = probes.filter((probe) => probe.status === 'up').length,
          down = probes.filter((probe) => probe.status === 'down').length
        return [
          monitor.id,
          {
            monitorId: monitor.id,
            historyLoaded: false,
            paused: !!monitor.paused,
            status: monitor.paused
              ? 'paused'
              : aggregateStatus(up, down, probes.length - up - down),
            up,
            down,
            unknown: probes.length - up - down,
            total: monitor.probes!.length,
            latest: probes.reduce<number | null>(
              (latest, probe) =>
                probe.latest === null ? latest : Math.max(latest ?? 0, probe.latest),
              null
            ),
            dailyHistory: [],
            uptimePercent: number(value.uptimePercent),
            retainedFrom: null,
            probes,
          } as ProbeMonitorSummary,
        ]
      })
  )
}
function nativeState(raw: unknown, monitors: MonitorTarget[]): string | null {
  if (typeof raw !== 'string') return null
  const source = record(JSON.parse(raw)),
    incident: MonitorStateCompacted['incident'] = {},
    latency: MonitorStateCompacted['latency'] = {}
  for (const monitor of monitors.filter((m) => !m.paused && !m.probes?.length)) {
    const prior = record(record(source.incident)[monitor.id]),
      sample = record(record(source.latency)[monitor.id])
    if (Array.isArray(prior.start) && Array.isArray(prior.end))
      incident[monitor.id] = {
        start: prior.start
          .slice(-1)
          .map((times) =>
            Array.isArray(times) ? times.filter((time) => number(time) !== null).slice(-1) : []
          ),
        end: prior.end.slice(-1).map(number),
        error: [
          (Array.isArray(prior.error) ? prior.error.slice(-1) : []).map((errors) => {
            const diagnostic = parseNativeDiagnostic(
              Array.isArray(errors) ? String(errors.slice(-1)[0] ?? '') : ''
            )
            return `[${diagnostic.stage}/${diagnostic.code}] Status observation`
          }),
        ],
      }
    if (typeof sample.time === 'string' && typeof sample.ping === 'string')
      latency[monitor.id] = {
        time: sample.time.slice(-8),
        ping: sample.ping.slice(-4),
        loc:
          sample.time.length && sample.ping.length
            ? { v: [string(record(sample.loc).v?.slice(-1)[0], 200) ?? 'UNKNOWN'], c: [1] }
            : { v: [], c: [] },
      }
  }
  return JSON.stringify({
    lastUpdate: number(source.lastUpdate) ?? 0,
    overallUp: 0,
    overallDown: 0,
    incident,
    latency,
  })
}
export function sanitizePublicSnapshot(raw: unknown): PublicDashboardSnapshot {
  const value = record(raw)
  if (
    value.version !== 1 ||
    !Number.isInteger(value.configRevision) ||
    value.configRevision < 0 ||
    number(value.generatedAt) === null
  )
    throw new Error('Invalid public snapshot')
  const monitors = publicMonitors(value.monitors),
    ids = new Set(monitors.map((m) => m.id))
  return {
    version: 1,
    configRevision: value.configRevision,
    generatedAt: value.generatedAt,
    complete: value.complete === true,
    monitors,
    page: publicPage(value.page, ids),
    maintenances: publicMaintenances(value.maintenances, ids),
    probeSummaries: safeSummaries(monitors, value.probeSummaries),
    compactedStateStr: nativeState(value.compactedStateStr, monitors),
  }
}
export function buildPublicDashboard(
  config: WorkerConfig,
  generatedAt: number,
  complete = false,
  probeSummaries: Record<string, ProbeMonitorSummary> = {},
  compactedStateStr: string | null = null
): PublicDashboardSnapshot {
  const labels = new Map((config.probes ?? []).map((probe) => [probe.id, probe]))
  const labeledSummaries = Object.fromEntries(
    config.monitors
      .filter((monitor) => monitor.probes?.length)
      .map((monitor) => {
        const summary = probeSummaries[monitor.id]
        const existing = new Map((summary?.probes ?? []).map((probe) => [probe.id, probe]))
        return [
          monitor.id,
          {
            ...summary,
            probes: monitor.probes!.map((id, index) => {
              const label = labels.get(id)
              return (
                existing.get(id) ?? {
                  id,
                  name:
                    label?.name ||
                    (label?.defaultName !== id ? label?.defaultName : undefined) ||
                    (id === 'cloudflare' ? 'Cloudflare' : `探针 ${index + 1}`),
                  location: label?.location || label?.defaultLocation,
                }
              )
            }),
          },
        ]
      })
  )
  return sanitizePublicSnapshot({
    version: 1,
    generatedAt,
    complete,
    configRevision: (config as WorkerConfig & { revision?: number }).revision ?? 0,
    monitors: config.monitors,
    ...getPresentationSettings(config),
    probeSummaries: labeledSummaries,
    compactedStateStr,
  })
}
function present(
  snapshot: PublicDashboardSnapshot,
  source: PublicDashboard['source'],
  now: number
): PublicDashboard {
  const stale =
    !snapshot.complete ||
    now - snapshot.generatedAt > PUBLIC_SNAPSHOT_MAX_AGE_SECONDS ||
    snapshot.generatedAt > now + 60
  const probeSummaries = Object.fromEntries(
    snapshot.monitors
      .filter((m) => m.probes?.length)
      .map((monitor) => {
        let summary = refreshProbeSummary(snapshot.probeSummaries[monitor.id], now, monitor)
        if (stale && !monitor.paused)
          summary = {
            ...summary,
            status: 'unknown',
            up: 0,
            down: 0,
            unknown: summary.total,
            probes: summary.probes.map((probe) => ({
              ...probe,
              status: 'unknown' as const,
              stale: true,
              stage: 'probe',
              code: 'snapshot_stale',
            })),
          }
        return [monitor.id, summary]
      })
  )
  return {
    configRevision: snapshot.configRevision,
    monitors: snapshot.monitors,
    page: snapshot.page,
    maintenances: snapshot.maintenances,
    probeSummaries,
    compactedStateStr: stale ? null : snapshot.compactedStateStr,
    snapshotAt: source !== 'd1' ? snapshot.generatedAt : null,
    snapshotIncomplete: !snapshot.complete,
    stale,
    source,
  }
}
function parseSnapshot(raw: string | null): PublicDashboardSnapshot | null {
  if (!raw) return null
  if (new TextEncoder().encode(raw).byteLength > MAX_SNAPSHOT_BYTES)
    throw new Error('Public snapshot exceeds limit')
  return sanitizePublicSnapshot(JSON.parse(raw))
}
function serializeSnapshot(snapshot: PublicDashboardSnapshot): string {
  const serialized = JSON.stringify(snapshot)
  if (new TextEncoder().encode(serialized).byteLength > MAX_SNAPSHOT_BYTES)
    throw new Error('Public snapshot exceeds limit')
  return serialized
}
function isD1ReadQuotaError(error: unknown): boolean {
  let value = error
  for (let depth = 0; value && depth < 5; depth++) {
    const current = record(value)
    if (current.code === 7500 || current.code === '7500') return true
    const message = typeof value === 'string' ? value : current.message
    if (
      typeof message === 'string' &&
      /(?:exceeded D1.?s free tier daily row read limit|D1[^\n]{0,100}daily (?:row )?read limit)/i.test(
        message
      )
    )
      return true
    value = current.cause
  }
  return false
}
async function recoverySnapshot(env: PublicDashboardEnv): Promise<PublicDashboardSnapshot> {
  if (!env.ASSETS) throw new Error('Public recovery snapshot is unavailable')
  const cache = (globalThis as any).caches?.default as Cache | undefined
  const url = RECOVERY_CACHE_URL
  let cached: Response | undefined
  try {
    cached = await cache?.match(url)
  } catch {
    /* Read the static asset if Cache API is unavailable. */
  }
  const response =
    cached ??
    (await env.ASSETS.fetch(
      new Request('https://uptimeflare-public-cache.invalid/public-dashboard-recovery.json')
    ))
  if (!response.ok || !response.body) throw new Error('Public recovery snapshot is unavailable')
  const reader = response.body.getReader(),
    decoder = new TextDecoder()
  let text = '',
    bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > MAX_SNAPSHOT_BYTES) throw new Error('Public recovery snapshot exceeds limit')
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
  } finally {
    await reader.cancel().catch(() => undefined)
  }
  const snapshot = parseSnapshot(text)
  if (!snapshot || snapshot.complete)
    throw new Error('Public recovery snapshot must contain metadata only')
  if (!cached)
    await cache
      ?.put(
        url,
        new Response(JSON.stringify(snapshot), {
          headers: { 'Cache-Control': 'public, max-age=60', 'Content-Type': 'application/json' },
        })
      )
      .catch(() => undefined)
  return snapshot
}
/** Public consumers never rebuild D1 or write KV. Persistent snapshots remain available during quota exhaustion. */
export async function getPublicDashboard(
  env: PublicDashboardEnv,
  fallback: WorkerConfig,
  now = Math.floor(Date.now() / 1000)
): Promise<PublicDashboard> {
  if (!env.UPTIMEFLARE_PUBLIC_KV) {
    // Retry D1 once the minute-long recovery cache expires, rather than sending every
    // anonymous page request to a database already known to have exhausted its quota.
    if (env.ASSETS) {
      try {
        const cached = await (globalThis as any).caches?.default?.match(RECOVERY_CACHE_URL)
        if (cached) {
          const snapshot = parseSnapshot(await cached.text())
          if (snapshot && !snapshot.complete) return present(snapshot, 'recovery', now)
        }
      } catch {
        /* Try the authoritative D1 path when Cache API is unavailable. */
      }
    }
    try {
      const config = await getRuntimeConfig(env, fallback)
      const [state, summaries] = await Promise.all([
        getPublicNativeState(env, config.monitors),
        getProbeDashboardSummaries(env, config.monitors, config.probes, now),
      ])
      return present(buildPublicDashboard(config, now, true, summaries, state), 'd1', now)
    } catch (error) {
      if (!isD1ReadQuotaError(error) || !env.ASSETS) throw error
      return present(await recoverySnapshot(env), 'recovery', now)
    }
  }
  const cache = (globalThis as any).caches?.default as Cache | undefined
  let bundle:
    | { snapshot: PublicDashboardSnapshot | null; override: PublicDashboardSnapshot | null }
    | undefined
  try {
    const cached = await cache?.match(CACHE_URL)
    if (cached) bundle = (await cached.json()) as typeof bundle
  } catch {
    /* A cache failure must not make a persisted snapshot unavailable. */
  }
  if (!bundle) {
    const [snapshot, override] = await Promise.all([
      env.UPTIMEFLARE_PUBLIC_KV.get(PUBLIC_DASHBOARD_KEY),
      env.UPTIMEFLARE_PUBLIC_KV.get(PUBLIC_CONFIGURATION_KEY),
    ])
    bundle = { snapshot: parseSnapshot(snapshot), override: parseSnapshot(override) }
    await cache
      ?.put(
        CACHE_URL,
        new Response(JSON.stringify(bundle), {
          headers: { 'Cache-Control': 'public, max-age=60', 'Content-Type': 'application/json' },
        })
      )
      .catch(() => undefined)
  }
  const first = bundle.snapshot && sanitizePublicSnapshot(bundle.snapshot),
    second = bundle.override && sanitizePublicSnapshot(bundle.override)
  const snapshot =
    second && (!first || second.configRevision > first.configRevision) ? second : first
  if (!snapshot) throw new Error('Public dashboard snapshot is unavailable')
  return present(snapshot, 'kv', now)
}
/** Cron is the only normal measurement publisher: once every two minutes, at most 720 writes/day. */
export async function publishPublicDashboard(
  env: PublicDashboardEnv,
  config: WorkerConfig,
  scheduledTime: number
): Promise<boolean> {
  if (!env.UPTIMEFLARE_PUBLIC_KV || Math.floor(scheduledTime / 60) % 2) return false
  // Duplicate delivery cannot spend another KV write for the same two-minute slot.
  const claimed = await env.UPTIMEFLARE_D1.prepare(
    `INSERT INTO uptimeflare(key,value) VALUES('public_snapshot_slot',?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value
     WHERE CAST(uptimeflare.value AS INTEGER)<CAST(excluded.value AS INTEGER)`
  )
    .bind(String(scheduledTime))
    .run()
  if (!claimed.meta.changes) return false
  const now = Math.floor(Date.now() / 1000)
  const [state, summaries] = await Promise.all([
    getPublicNativeState(env, config.monitors),
    getProbeDashboardSummaries(env, config.monitors, config.probes, now),
  ])
  const snapshot = buildPublicDashboard(config, now, true, summaries, state)
  await env.UPTIMEFLARE_PUBLIC_KV.put(PUBLIC_DASHBOARD_KEY, serializeSnapshot(snapshot))
  return true
}
/** Separate configuration override prevents an older in-flight Cron snapshot undoing a saved pause. */
export async function publishPublicConfiguration(
  env: PublicDashboardEnv,
  config: WorkerConfig,
  revision: number
): Promise<void> {
  const kv = env.UPTIMEFLARE_PUBLIC_KV
  if (!kv) return
  const nonce = crypto.randomUUID()
  // This non-expiring publication lock spans isolates. Regranting a timed lease would
  // allow an old KV put to finish after a newer publisher and regress the head.
  // Overlap or a crashed owner only delays immediate overrides: Cron publishes the
  // current revision independently, and readers always prefer the greater revision.
  const claim = await env.UPTIMEFLARE_D1.prepare(
    `INSERT INTO uptimeflare(key,value) VALUES('public_config_publisher',?) ON CONFLICT(key) DO NOTHING`
  )
    .bind(nonce)
    .run()
  if (!claim.meta.changes) return
  try {
    const saved = await env.UPTIMEFLARE_D1.prepare(
      'SELECT revision FROM admin_config WHERE id=1'
    ).first<{ revision: number }>()
    if (saved?.revision !== revision) return
    const prior = parseSnapshot(await kv.get(PUBLIC_CONFIGURATION_KEY))
    if (prior && prior.configRevision >= revision) return
    const snapshot = buildPublicDashboard(
      { ...config, revision } as WorkerConfig,
      Math.floor(Date.now() / 1000)
    )
    await kv.put(PUBLIC_CONFIGURATION_KEY, serializeSnapshot(snapshot))
    await (globalThis as any).caches?.default?.delete(CACHE_URL).catch(() => undefined)
  } finally {
    await env.UPTIMEFLARE_D1.prepare(
      "DELETE FROM uptimeflare WHERE key='public_config_publisher' AND value=?"
    )
      .bind(nonce)
      .run()
  }
}
