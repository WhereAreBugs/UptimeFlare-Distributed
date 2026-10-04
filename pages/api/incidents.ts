import type { NextRequest } from 'next/server'
import { getRuntimeConfig } from '@/worker/src/settings'
import { getProbeIncidents } from '@/worker/src/probes'
import { getNativeIncidents } from '@/worker/src/incident-history'

export const runtime = 'edge'
const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }

export default async function handler(request: NextRequest): Promise<Response> {
  if (request.method !== 'GET')
    return new Response(null, { status: 405, headers: { ...headers, Allow: 'GET' } })
  const url = new URL(request.url)
  const number = (key: string) =>
    url.searchParams.has(key) ? Number(url.searchParams.get(key)) : undefined
  const kind = url.searchParams.get('kind') ?? 'all'
  const query = {
    from: number('from'),
    to: number('to'),
    limit: number('limit'),
    monitorId: url.searchParams.get('monitor') || undefined,
  }
  if (
    !['all', 'probes', 'native'].includes(kind) ||
    Object.values(query).some((value) => typeof value === 'number' && !Number.isSafeInteger(value))
  )
    return new Response(JSON.stringify({ error: 'Invalid history query' }), {
      status: 400,
      headers,
    })
  try {
    const { workerConfig: fallbackConfig } = await import('@/uptime.config')
    const config = await getRuntimeConfig(process.env as any, fallbackConfig)
    const [probes, native] = await Promise.all([
      kind !== 'native'
        ? getProbeIncidents(process.env as any, config.monitors, config.probes, {
            ...query,
            probeId: url.searchParams.get('probe') || undefined,
            cursor: url.searchParams.get('cursor') || undefined,
          })
        : null,
      kind !== 'probes'
        ? getNativeIncidents(process.env as any, config.monitors, {
            ...query,
            cursor: url.searchParams.get('nativeCursor') || undefined,
          })
        : null,
    ])
    return new Response(JSON.stringify({ probes, native }), { headers })
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    const invalid = /^(Invalid|Unknown)/.test(message)
    return new Response(
      JSON.stringify({
        error: invalid ? 'Invalid history query' : 'History is temporarily unavailable',
      }),
      { status: invalid ? 400 : 503, headers }
    )
  }
}
