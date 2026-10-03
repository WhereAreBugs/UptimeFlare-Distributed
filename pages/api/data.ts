import { maintenances, workerConfig as fallbackConfig } from '@/uptime.config'
import { NextRequest } from 'next/server'
import { CompactedMonitorStateWrapper, getFromStore } from '@/worker/src/store'
import { getRuntimeConfig } from '@/worker/src/settings'
import { getProbeSummaries } from '@/worker/src/probes'
import { parseNativeDiagnostic } from '@/worker/src/diagnostics'

export const runtime = 'edge'

const headers = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'no-store',
}

export default async function handler(req: NextRequest): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers })
  if (req.method !== 'GET')
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { ...headers, Allow: 'GET, OPTIONS' },
    })
  const workerConfig = await getRuntimeConfig(process.env as any, fallbackConfig)
  const [stateStr, probeSummaries] = await Promise.all([
    getFromStore(process.env as any, 'state'),
    getProbeSummaries(
      process.env as any,
      workerConfig.monitors,
      workerConfig.probes,
      Math.round(Date.now() / 1000),
      workerConfig.probeStaleAfterSeconds
    ),
  ])
  const compactedState = new CompactedMonitorStateWrapper(stateStr)

  if (
    compactedState.data.lastUpdate === 0 &&
    !workerConfig.monitors.some((monitor) => monitor.probes?.length)
  ) {
    return new Response(JSON.stringify({ error: 'No data available' }), {
      status: 500,
      headers,
    })
  }

  let monitors: any = {}
  const counts = { up: 0, down: 0, degraded: 0, unknown: 0 }
  let updatedAt = 0

  for (let monitor of workerConfig.monitors) {
    if (monitor.probes?.length) {
      const summary = probeSummaries[monitor.id]
      counts[summary.status]++
      updatedAt = Math.max(updatedAt, summary.latest ?? 0)
      monitors[monitor.id] = {
        ...summary,
        up: summary.status === 'unknown' ? null : summary.status === 'up',
        reachableProbes: summary.up,
        unreachableProbes: summary.down,
        unknownProbes: summary.unknown,
      }
      continue
    }
    updatedAt = Math.max(updatedAt, compactedState.data.lastUpdate)
    const incidentCount = compactedState.incidentLen(monitor.id)
    const lastIncident = incidentCount
      ? compactedState.getIncident(monitor.id, incidentCount - 1)
      : null
    const latency = compactedState.latencyLen(monitor.id)
      ? compactedState.getLastLatency(monitor.id)
      : null
    const status = !latency || !lastIncident ? 'unknown' : lastIncident.end === null ? 'down' : 'up'
    const failure =
      status === 'down'
        ? parseNativeDiagnostic(lastIncident!.error[lastIncident!.error.length - 1])
        : null
    counts[status]++

    monitors[monitor.id] = {
      status,
      up: status === 'unknown' ? null : status === 'up',
      latency: latency?.ping ?? null,
      location: latency?.loc ?? null,
      message:
        status === 'unknown'
          ? 'No data available'
          : status === 'up'
          ? 'OK'
          : lastIncident?.error[lastIncident.error.length - 1],
      ...(failure && { stage: failure.stage, code: failure.code }),
    }
  }

  let ret = {
    ...counts,
    updatedAt,
    monitors,
    maintenances,
  }

  return new Response(JSON.stringify(ret), {
    headers,
  })
}
