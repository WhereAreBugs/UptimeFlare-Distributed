import type { WorkerConfig } from '../../types/config'
import type { ProbeEnv } from './probes'
import { getProbeSummaries } from './probes'
import { getPublicNativeState } from './store'

function json(value: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
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
  config: WorkerConfig
): Promise<Response> {
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405, { Allow: 'GET' })
  const url = new URL(request.url)
  const keys = Array.from(url.searchParams.keys())
  const id = url.searchParams.get('id')
  if (
    url.pathname !== '/api/history' ||
    keys.length !== 1 ||
    keys[0] !== 'id' ||
    !id ||
    !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(id)
  )
    return json({ error: 'Invalid history request' }, 400)
  const monitor = config.monitors.find((target) => target.id === id && !target.paused)
  if (!monitor) return json({ error: 'Monitor not found' }, 404)
  try {
    if (monitor.probes?.length) {
      const summaries = await getProbeSummaries(env, [monitor], config.probes)
      return json({ monitorId: id, summary: summaries[id] })
    }
    return json({
      monitorId: id,
      compactedStateStr: await getPublicNativeState(env, [monitor], true),
      historyLoaded: true,
    })
  } catch {
    return json({ error: 'History is temporarily unavailable' }, 503)
  }
}
