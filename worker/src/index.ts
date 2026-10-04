import { withResources } from './resources'
export { Coordinator } from './coordinator'
import type { Coordinator } from './coordinator'
import { deliverNotifications } from './notifications'
import { createExecutionBudget } from './execution-budget'
import { pageAccess } from './access'
import { RegionalExecutor, type RegionalRequest } from './regional'
import dataHandler from './http/data'
import badgeHandler from './http/badge'
import incidentsHandler from './http/incidents'
import { publicStateResponse } from './public-dashboard'
import { runNativeMonitors } from './native-monitor'
import { cleanupMonitorSchedules } from './scheduling'
import { DurableObject } from 'cloudflare:workers'
import type { MonitorTarget } from '../../types/config'
import { workerConfig as fallbackConfig } from '../../uptime.config'
import { getStatus } from './monitor'
import { getWorkerLocation } from './util'
import { handleProbeRequest, cleanupProbeResults, preflightProbeRequest } from './probes'
import { getRuntimeConfig } from './settings'
import { handleAdminRequest } from './admin'
import { runCloudflareProbe } from './cloudflare-probe'
import { MAX_SCHEDULED_TARGETS_PER_CRON } from './limits'
import { runNotifications } from './notifications'
import { handleManagementRequest } from './management'
import { handlePublicHistoryRequest } from './history'
import { publishPublicDashboard } from './public-dashboard'

export interface Env {
  COORDINATOR_DO?: DurableObjectNamespace<Coordinator>
  STATE_STORAGE_VERSION?: string
  METRICS_ENABLED?: string
  MIGRATION_MODE?: string
  REMOTE_CHECKER_DO: DurableObjectNamespace<RemoteChecker>
  UPTIMEFLARE_D1: D1Database
  UPTIMEFLARE_PUBLIC_KV?: KVNamespace
  ASSETS?: Fetcher
  PROBE_TOKENS?: string
  ADMIN_PASSWORD?: string
  ADMIN_SESSION_SECRET?: string
}

const implementation = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const access = pageAccess(request, fallbackConfig.passwordProtection)
    if (access) return access
    const pathname = new URL(request.url).pathname
    if (pathname === '/api/data') return dataHandler(request, env)
    if (pathname === '/api/badge') return badgeHandler(request, env)
    if (pathname === '/api/incidents') return incidentsHandler(request, env)
    if (pathname === '/api/state') {
      if (request.method !== 'GET')
        return new Response(null, { status: 405, headers: { Allow: 'GET' } })
      try {
        return await publicStateResponse(env, fallbackConfig)
      } catch {
        return Response.json({ error: 'Public dashboard temporarily unavailable' }, { status: 503 })
      }
    }
    if (!pathname.startsWith('/api/')) {
      if (!env.ASSETS) return new Response('Not found', { status: 404 })
      return env.ASSETS.fetch(request)
    }
    if (new URL(request.url).pathname.startsWith('/api/admin/'))
      return handleAdminRequest(request, env, fallbackConfig)
    if (new URL(request.url).pathname.startsWith('/api/manage/'))
      return handleManagementRequest(request, env, fallbackConfig)
    if (pathname !== '/api/history') {
      const preflight = preflightProbeRequest(request, env)
      if (preflight) return preflight
    } else if (request.method !== 'GET') {
      return new Response(null, { status: 405, headers: { Allow: 'GET' } })
    }
    if (env.MIGRATION_MODE === '1' && pathname === '/api/probes/ingest')
      return Response.json(
        { error: 'Storage migration in progress; retry the same batch' },
        { status: 503 }
      )
    if (pathname === '/api/history') return handlePublicHistoryRequest(request, env)
    const workerConfig = await getRuntimeConfig(env, fallbackConfig)
    return handleProbeRequest(
      request,
      env,
      workerConfig.monitors,
      request.cf as IncomingRequestCfProperties | undefined
    )
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    if (env.MIGRATION_MODE === '1') return
    ctx.waitUntil(
      cleanupProbeResults(env).catch(() => console.error('Probe retention cleanup failed'))
    )
    const workerConfig = await getRuntimeConfig(env, fallbackConfig)
    ctx.waitUntil(
      env.UPTIMEFLARE_D1.prepare(
        'DELETE FROM admin_login_attempts WHERE address IN (SELECT address FROM admin_login_attempts WHERE window < ? LIMIT 1000)'
      )
        .bind(Math.floor(Date.now() / 1000 / 900) - 2)
        .run()
        .catch(() => console.error('Admin login cleanup failed'))
    )
    const time = Math.floor(event.scheduledTime / 60000) * 60
    let location: Promise<string> | undefined
    const getLocation = () =>
      (location ??= getWorkerLocation()
        .catch(() => undefined)
        .then((value) => value || 'UNKNOWN'))
    await cleanupMonitorSchedules(env, workerConfig.monitors)
    const active = workerConfig.monitors.filter((monitor) => !monitor.paused)
    const cloudflareCount = active.filter(
      (monitor) => monitor.probes?.includes('cloudflare')
    ).length
    const nativeCount = active.filter((monitor) => !monitor.probes?.length).length
    const budget = createExecutionBudget()
    // Reserve a proportional share so a busy Cloudflare scope cannot starve legacy native targets.
    const cloudflareLimit =
      nativeCount && cloudflareCount
        ? Math.max(
            1,
            Math.floor((budget.remaining * cloudflareCount) / (cloudflareCount + nativeCount))
          )
        : budget.remaining
    await runCloudflareProbe(
      env,
      workerConfig.monitors,
      time,
      getLocation,
      undefined,
      budget,
      cloudflareLimit
    )
    await runNativeMonitors(env, workerConfig, time, getLocation, undefined, budget)
    if (env.STATE_STORAGE_VERSION === '2' && env.COORDINATOR_DO) {
      const coordinator = env.COORDINATOR_DO.get(env.COORDINATOR_DO.idFromName('state-v2'))
      await coordinator.evaluate(Math.floor(Date.now() / 1000))
      await deliverNotifications(env, workerConfig, Math.floor(Date.now() / 1000))
      await coordinator.materialize(time)
    } else {
      await runNotifications(env, workerConfig, Math.floor(Date.now() / 1000)).catch(() =>
        console.error('Notification evaluation failed')
      )
      await publishPublicDashboard(env, workerConfig, time).catch(() =>
        console.error('Public dashboard snapshot publication failed; retaining last known data')
      )
    }
  },
}

export default {
  fetch(request: Request, env: Env) {
    return withResources(env, 'root-fetch', (measured) =>
      implementation.fetch(request, measured)
    ).catch(() => Response.json({ error: 'Service temporarily unavailable' }, { status: 503 }))
  },
  scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    return withResources(env, 'root-cron', (measured) =>
      implementation.scheduled(event, measured, ctx)
    )
  },
}

export class RemoteChecker extends DurableObject {
  private executor = new RegionalExecutor()
  async checkBatch(request: RegionalRequest) {
    return this.executor.checkBatch(request)
  }
  async protocol() {
    return { regional: 1 }
  }
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
  }

  async getLocationAndStatus(
    monitor: MonitorTarget
  ): Promise<{ location: string; status: { ping: number; up: boolean; err: string } }> {
    const colo = (await getWorkerLocation()) as string
    console.log(`Running remote checker (DurableObject) at ${colo}...`)
    const status = await getStatus(monitor)
    return {
      location: colo,
      status: status,
    }
  }

  // Old clients may call this during a rolling upgrade. Instances now hibernate naturally.
  async kill() {
    return
  }
}
