import { NextRequest } from 'next/server'
import { CompactedMonitorStateWrapper, getFromStore } from '@/worker/src/store'
import { getProbeSummaries } from '@/worker/src/probes'
import type { MonitorStatus } from '@/util/probe-status'

export const runtime = 'edge'

type BadgePayload = {
  schemaVersion: 1
  label: string
  message: string
  color: string
  isError?: boolean
}

const jsonHeaders = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store, max-age=0, must-revalidate',
}

function errorBadge(label: string, message: string): BadgePayload {
  return {
    schemaVersion: 1,
    label,
    message,
    color: 'lightgrey',
    isError: true,
  }
}

export default async function handler(req: NextRequest): Promise<Response> {
  try {
    const url = new URL(req.url)

    const monitorId = url.searchParams.get('id')
    const label = url.searchParams.get('label') ?? monitorId ?? 'UptimeFlare'

    const upMsg = url.searchParams.get('up') ?? 'UP'
    const downMsg = url.searchParams.get('down') ?? 'DOWN'
    const colorUp = url.searchParams.get('colorUp') ?? 'brightgreen'
    const colorDown = url.searchParams.get('colorDown') ?? 'red'

    if (!monitorId) {
      return new Response(JSON.stringify(errorBadge(label, 'no-monitor')), {
        headers: jsonHeaders,
        status: 400,
      })
    }

    const { workerConfig } = await import('@/uptime.config')
    const monitor = workerConfig.monitors.find((monitor) => monitor.id === monitorId)
    if (!monitor)
      return new Response(JSON.stringify(errorBadge(label, 'monitor-not-found')), {
        status: 404,
        headers: jsonHeaders,
      })
    let status: MonitorStatus = 'unknown'
    if (monitor.probes?.length) {
      const summaries = await getProbeSummaries(
        process.env as any,
        [monitor],
        workerConfig.probes,
        Math.round(Date.now() / 1000),
        workerConfig.probeStaleAfterSeconds
      )
      status = summaries[monitor.id].status
    } else {
      const compactedState = new CompactedMonitorStateWrapper(
        await getFromStore(process.env as any, 'state')
      )
      const incidentCount = compactedState.incidentLen(monitorId)
      const lastIncident = incidentCount
        ? compactedState.getIncident(monitorId, incidentCount - 1)
        : null
      if (compactedState.latencyLen(monitorId) && lastIncident)
        status = lastIncident.end === null ? 'down' : 'up'
    }

    const badge: BadgePayload = {
      schemaVersion: 1,
      label,
      message:
        status === 'up'
          ? upMsg
          : status === 'down'
          ? downMsg
          : status === 'degraded'
          ? url.searchParams.get('degraded') ?? 'PARTIAL'
          : url.searchParams.get('unknown') ?? 'UNKNOWN',
      color:
        status === 'up'
          ? colorUp
          : status === 'down'
          ? colorDown
          : status === 'degraded'
          ? url.searchParams.get('colorDegraded') ?? 'orange'
          : url.searchParams.get('colorUnknown') ?? 'lightgrey',
    }

    return new Response(JSON.stringify(badge), {
      headers: jsonHeaders,
    })
  } catch (err) {
    console.error('Error rendering badge API:', err)
    return new Response(JSON.stringify(errorBadge('status', 'error')), {
      headers: jsonHeaders,
      status: 500,
    })
  }
}
