import type { PublicDashboardEnv } from '../public-dashboard'

import { CompactedMonitorStateWrapper, getPublicNativeState } from '../../../worker/src/store'
import { getProbeDashboardSummaries } from '../../../worker/src/probes'
import type { MonitorStatus } from '../../../util/probe-status'
import { getMonitorStaleAfterSeconds } from '../../../util/monitor-settings'

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

export default async function handler(req: Request, env: PublicDashboardEnv): Promise<Response> {
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

    const { workerConfig: fallbackConfig } = await import('../../../uptime.config')
    const { getPublicDashboard } = await import('../public-dashboard')
    const dashboard = await getPublicDashboard(env, fallbackConfig)
    const workerConfig = dashboard
    const monitor = workerConfig.monitors.find((monitor) => monitor.id === monitorId)
    if (!monitor)
      return new Response(JSON.stringify(errorBadge(label, 'monitor-not-found')), {
        status: 404,
        headers: jsonHeaders,
      })
    if (monitor.paused)
      return new Response(
        JSON.stringify({
          schemaVersion: 1,
          label,
          message: url.searchParams.get('paused') ?? 'CLOSED',
          color: url.searchParams.get('colorPaused') ?? 'lightgrey',
        } satisfies BadgePayload),
        { headers: jsonHeaders }
      )
    let status: MonitorStatus = 'unknown'
    if (monitor.probes?.length) {
      const summaries = dashboard.probeSummaries
      const summary = summaries[monitor.id]
      status = summary.status === 'paused' ? 'unknown' : summary.status
    } else {
      const compactedState = new CompactedMonitorStateWrapper(dashboard.compactedStateStr)
      const incidentCount = compactedState.incidentLen(monitorId)
      const lastIncident = incidentCount
        ? compactedState.getIncident(monitorId, incidentCount - 1)
        : null
      if (compactedState.latencyLen(monitorId) && lastIncident) {
        const latest = compactedState.getLastLatency(monitorId).time
        if (Math.floor(Date.now() / 1000) - latest <= getMonitorStaleAfterSeconds(monitor))
          status = lastIncident.end === null ? 'down' : 'up'
      }
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
    console.error('Badge rendering failed')
    return new Response(JSON.stringify(errorBadge('status', 'error')), {
      headers: jsonHeaders,
      status: 500,
    })
  }
}
