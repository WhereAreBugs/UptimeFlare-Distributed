import { workerConfig as fallbackConfig } from '@/uptime.config'
import { expandMaintenances } from '@/util/maintenance'
import { NextRequest } from 'next/server'
import { CompactedMonitorStateWrapper } from '@/worker/src/store'
import { getPublicDashboard } from '@/worker/src/public-dashboard'
import { parseNativeDiagnostic } from '@/worker/src/diagnostics'
import { getMonitorStaleAfterSeconds } from '@/util/monitor-settings'
import { getMonitorCategory } from '@/util/dashboard-status'

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
  let dashboard
  try {
    dashboard = await getPublicDashboard(process.env as any, fallbackConfig)
  } catch {
    return new Response(JSON.stringify({ error: 'Public dashboard temporarily unavailable' }), {
      status: 503,
      headers,
    })
  }
  const workerConfig = dashboard
  const stateStr = dashboard.compactedStateStr
  const probeSummaries = dashboard.probeSummaries
  const compactedState = new CompactedMonitorStateWrapper(stateStr)
  const now = Math.floor(Date.now() / 1000)
  const maintenances = expandMaintenances(dashboard.maintenances, now - 86400, now + 30 * 86400)

  if (
    compactedState.data.lastUpdate === 0 &&
    !workerConfig.monitors.some((monitor) => monitor.probes?.length || monitor.paused)
  ) {
    return new Response(JSON.stringify({ error: 'No data available' }), {
      status: 500,
      headers,
    })
  }

  let monitors: any = {}
  const counts = { up: 0, down: 0, degraded: 0, unknown: 0, paused: 0 }
  const categories = { healthy: 0, closed: 0, maintenance: 0, abnormal: 0 }
  let updatedAt = 0

  for (let monitor of workerConfig.monitors) {
    if (monitor.paused) {
      counts.paused++
      categories.closed++
      monitors[monitor.id] = {
        status: 'paused',
        paused: true,
        category: 'closed',
        up: null,
        reachableProbes: null,
        unreachableProbes: null,
        unknownProbes: null,
        historyLoaded: false,
      }
      continue
    }
    if (monitor.probes?.length) {
      const summary = probeSummaries[monitor.id]
      const paused = !!(monitor.paused || summary.paused || summary.status === 'paused')
      const status = paused ? 'paused' : summary.status
      const category = getMonitorCategory(monitor, status, maintenances, now)
      counts[status]++
      categories[category]++
      if (!paused) updatedAt = Math.max(updatedAt, summary.latest ?? 0)
      monitors[monitor.id] = {
        ...summary,
        status,
        paused,
        category,
        up: paused || status === 'unknown' ? null : status === 'up',
        reachableProbes: paused ? null : summary.up,
        unreachableProbes: paused ? null : summary.down,
        unknownProbes: paused ? null : summary.unknown,
      }
      continue
    }
    const incidentCount = compactedState.incidentLen(monitor.id)
    const lastIncident = incidentCount
      ? compactedState.getIncident(monitor.id, incidentCount - 1)
      : null
    const latency = compactedState.latencyLen(monitor.id)
      ? compactedState.getLastLatency(monitor.id)
      : null
    if (!monitor.paused) updatedAt = Math.max(updatedAt, latency?.time ?? 0)
    const stale =
      !latency ||
      Math.floor(Date.now() / 1000) - latency.time > getMonitorStaleAfterSeconds(monitor)
    const status = monitor.paused
      ? 'paused'
      : stale || !lastIncident
      ? 'unknown'
      : lastIncident.end === null
      ? 'down'
      : 'up'
    const failure =
      status === 'down'
        ? parseNativeDiagnostic(lastIncident!.error[lastIncident!.error.length - 1])
        : null
    counts[status]++
    const category = getMonitorCategory(monitor, status, maintenances, now)
    categories[category]++

    monitors[monitor.id] = {
      status,
      paused: !!monitor.paused,
      category,
      up: status === 'paused' || status === 'unknown' ? null : status === 'up',
      latency: latency?.ping ?? null,
      location: latency?.loc ?? null,
      message:
        status === 'paused'
          ? 'Monitoring paused; results are historical'
          : status === 'unknown'
          ? 'No data available'
          : status === 'up'
          ? 'OK'
          : lastIncident?.error[lastIncident.error.length - 1],
      ...(failure && { stage: failure.stage, code: failure.code }),
    }
  }

  let ret = {
    ...counts,
    ...categories,
    total: workerConfig.monitors.length,
    updatedAt,
    monitors,
    maintenances,
    snapshotAt: dashboard.snapshotAt,
    snapshotIncomplete: dashboard.snapshotIncomplete,
    stale: dashboard.stale,
    source: dashboard.source,
    configRevision: dashboard.configRevision,
  }

  return new Response(JSON.stringify(ret), {
    headers,
  })
}
