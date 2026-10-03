import { runNativeMonitors } from './native-monitor'
import { cleanupMonitorSchedules } from './scheduling'
import { DurableObject } from 'cloudflare:workers'
import type { MonitorTarget } from '../../types/config'
import { workerConfig as fallbackConfig } from '../../uptime.config'
import { getStatus } from './monitor'
import { getWorkerLocation } from './util'
import { handleProbeRequest, cleanupProbeResults } from './probes'
import { getRuntimeConfig } from './settings'
import { handleAdminRequest } from './admin'
import { runCloudflareProbe } from './cloudflare-probe'
import { runNotifications } from './notifications'

export interface Env {
  REMOTE_CHECKER_DO: DurableObjectNamespace<RemoteChecker>
  UPTIMEFLARE_D1: D1Database
  PROBE_TOKENS?: string
  ADMIN_PASSWORD?: string
  ADMIN_SESSION_SECRET?: string
}

const Worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname.startsWith('/api/admin/'))
      return handleAdminRequest(request, env, fallbackConfig)
    const workerConfig = await getRuntimeConfig(env, fallbackConfig)
    return handleProbeRequest(
      request,
      env,
      workerConfig.monitors,
      request.cf as IncomingRequestCfProperties | undefined
    )
  },
  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
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
    await runCloudflareProbe(env, workerConfig.monitors, time, getLocation)
    await runNativeMonitors(env, workerConfig, time, getLocation)
    await runNotifications(env, workerConfig, Math.floor(Date.now() / 1000)).catch(() =>
      console.error('Notification evaluation failed')
    )
  },
}

export default Worker

export class RemoteChecker extends DurableObject {
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

  async kill() {
    // Throwing an error in `blockConcurrencyWhile` will terminate the Durable Object instance
    // https://developers.cloudflare.com/durable-objects/api/state/#blockconcurrencywhile
    this.ctx.blockConcurrencyWhile(async () => {
      throw 'killed'
    })
  }
}
