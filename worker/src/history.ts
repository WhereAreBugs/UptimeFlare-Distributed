import type { WorkerConfig } from '../../types/config'
import type { ProbeEnv } from './probes'
import { getProbeSummaries } from './probes'
import { getPublicNativeState } from './store'
import { getPublicDashboard, publicMonitors, CACHE_URL } from './public-dashboard'
import { resourceIdentity } from './resources'
import { getRuntimeConfig } from './settings'
import { workerConfig } from '../../uptime.config'
const inFlight = new WeakMap<object, Map<string, Promise<Response>>>()

function json(value: unknown, status = 200, extra: Record<string, string> = {}) {
  const body = JSON.stringify(value)
  if (new TextEncoder().encode(body).byteLength > 1024 * 1024)
    return json({ error: 'History response exceeds budget; request a shorter time range' }, 413)
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  })
}

/** Public, active-target-only history. Never returns monitor configuration or credentials. */
export async function handlePublicHistoryRequest(
  request: Request,
  env: ProbeEnv,
  config?: WorkerConfig
): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, { Allow: 'GET' })
  const url = new URL(request.url)
  const keys = Array.from(url.searchParams.keys())
  const id = url.searchParams.get('id')
  const now = Math.floor(Date.now() / 1000)
  const from = Number(url.searchParams.get('from') ?? now - 43200)
  const to = Number(url.searchParams.get('to') ?? now + 1)
  if (
    url.pathname !== '/api/history' ||
    keys.some(
      (key) => !['id', 'from', 'to'].includes(key) || url.searchParams.getAll(key).length !== 1
    ) ||
    !Number.isSafeInteger(from) ||
    !Number.isSafeInteger(to) ||
    from >= to ||
    from < now - 90 * 86400 ||
    to > now + 1 ||
    to - from > 43201 ||
    !id ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(id)
  )
    return json({ error: 'Invalid history request' }, 400)
  if (!config && !env.UPTIMEFLARE_PUBLIC_KV) {
    // Compatibility deployments without KV need only configuration metadata;
    // loading every target's current summary would defeat a scoped history read.
    const runtime = await getRuntimeConfig(env, workerConfig)
    config = {
      monitors: publicMonitors(runtime.monitors),
      probes: runtime.probes?.map(({ id, name, location }) => ({ id, name, location })),
    }
  }
  let revision = (config as (WorkerConfig & { revision?: number }) | undefined)?.revision ?? 0
  if (!config) {
    const dashboard = await getPublicDashboard(env, workerConfig)
    revision = dashboard.configRevision
    config = {
      monitors: dashboard.monitors,
      probes: Array.from(
        new Map(
          Object.values(dashboard.probeSummaries).flatMap((summary) =>
            summary.probes.map(
              (probe) =>
                [
                  probe.id,
                  { id: probe.id, name: probe.name, location: probe.location ?? undefined },
                ] as const
            )
          )
        ).values()
      ),
    }
  }
  const monitor = config.monitors.find((target) => target.id === id && !target.paused)
  if (!monitor) return json({ error: 'Monitor not found' }, 404)
  const definitions = config.probes
  // Validate current lifecycle BEFORE using a shared cached history. Admin and
  // bearer-token responses never enter this public cache.
  const key = new URL(CACHE_URL + '/history-v1')
  key.searchParams.set('id', id)
  key.searchParams.set('revision', String(revision))
  key.searchParams.set('probes', (monitor.probes ?? []).join(','))
  key.searchParams.set('from', String(url.searchParams.has('from') ? from : Math.floor(now / 60)))
  key.searchParams.set('to', String(url.searchParams.has('to') ? to : Math.floor(now / 60)))
  const cache = (globalThis as any).caches?.default as Cache | undefined
  const client = (response: Response) =>
    new Response(response.body, {
      status: response.status,
      headers: {
        ...Object.fromEntries(response.headers),
        'cache-control': response.ok ? 'private,max-age=30' : 'no-store',
        vary: 'Authorization',
      },
    })
  const saved = await cache?.match(key.toString()).catch(() => undefined)
  if (saved) return client(saved)
  const identity = resourceIdentity(env.UPTIMEFLARE_D1)
  let requests = inFlight.get(identity)
  if (!requests) {
    requests = new Map()
    inFlight.set(identity, requests)
  }
  let pending = requests.get(key.toString())
  if (pending) return client((await pending).clone())
  if (requests.size >= 16)
    return json({ error: 'History is temporarily busy' }, 503, { 'Retry-After': '5' })
  const load = async () => {
    try {
      if (monitor.probes?.length) {
        const summaries = await getProbeSummaries(env, [monitor], definitions, now, { from, to })
        return json({ monitorId: id, summary: summaries[id] })
      }
      return json({
        monitorId: id,
        compactedStateStr: await getPublicNativeState(env, [monitor], true, from, to),
        historyLoaded: true,
      })
    } catch {
      return json({ error: 'History is temporarily unavailable' }, 503)
    }
  }
  pending = load().then(async (response) => {
    if (response.ok)
      await cache
        ?.put(
          key.toString(),
          new Response(response.clone().body, {
            headers: {
              ...Object.fromEntries(response.headers),
              'cache-control': 'public,max-age=60',
            },
          })
        )
        .catch(() => undefined)
    return response
  })
  requests.set(key.toString(), pending)
  try {
    return client((await pending).clone())
  } finally {
    requests.delete(key.toString())
  }
}
