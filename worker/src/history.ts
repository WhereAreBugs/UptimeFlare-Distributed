import type { WorkerConfig } from '../../types/config'
import type { ProbeEnv } from './probes'
import { getProbeSummaries } from './probes'
import { getPublicNativeState } from './store'
import { getPublicDashboard, publicMonitors } from './public-dashboard'
import { getRuntimeConfig } from './settings'
import { workerConfig } from '../../uptime.config'

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
  if (!config) {
    const dashboard = await getPublicDashboard(env, workerConfig)
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
  try {
    if (monitor.probes?.length) {
      const summaries = await getProbeSummaries(env, [monitor], config.probes, now, { from, to })
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
