import pLimit from 'p-limit'
import type { MonitorTarget } from '../../types/config'
import type { Env } from './index'
import type { NativeCheckStatus } from './diagnostics'
import { doMonitor, getStatus } from './monitor'
import { getWorkerLocation, withTimeout } from './util'

export const REGIONAL_PROTOCOL = 1
export const MAX_REGIONAL_BATCH = 40
export type CheckResult = { id: string; location: string; status: NativeCheckStatus }
export type RegionalRequest = {
  version: 1
  runId: string
  configVersion: string
  monitors: MonitorTarget[]
}
export type RegionalResponse = {
  version: 1
  runId: string
  configVersion: string
  results: CheckResult[]
}

export function validateRegionalResponse(raw: unknown, request: RegionalRequest): CheckResult[] {
  const response = raw as RegionalResponse
  if (
    !response ||
    response.version !== REGIONAL_PROTOCOL ||
    response.runId !== request.runId ||
    response.configVersion !== request.configVersion ||
    !Array.isArray(response.results) ||
    response.results.length !== request.monitors.length
  )
    throw new Error('Regional protocol mismatch')
  const expected = new Set(request.monitors.map((m) => m.id)),
    seen = new Set<string>()
  for (const item of response.results) {
    if (
      !item ||
      !expected.has(item.id) ||
      seen.has(item.id) ||
      typeof item.location !== 'string' ||
      item.location.length > 200 ||
      typeof item.status?.up !== 'boolean' ||
      typeof item.status.err !== 'string' ||
      item.status.err.length > 2048 ||
      !Number.isFinite(item.status.ping) ||
      item.status.ping < 0 ||
      item.status.ping > 300000
    )
      throw new Error('Invalid regional result')
    seen.add(item.id)
  }
  return response.results
}

/** A single instance queue covers overlapping RPCs. No raw request data enters logs. */
export class RegionalExecutor {
  private queue = pLimit(5)
  private location = 'UNKNOWN'
  private retryLocationAt = 0
  private locationRequest?: Promise<string>
  private configurations = new Map<string, MonitorTarget[]>()
  constructor(
    private check = getStatus,
    private locate = getWorkerLocation
  ) {}
  private async getLocation() {
    if (this.location !== 'UNKNOWN' || Date.now() < this.retryLocationAt) return this.location
    if (!this.locationRequest)
      this.locationRequest = this.locate()
        .then((value) => {
          this.location = value && /^[A-Z]{3}$/.test(value) ? value : 'UNKNOWN'
          return this.location
        })
        .catch(() => 'UNKNOWN')
        .finally(() => {
          if (this.location === 'UNKNOWN') this.retryLocationAt = Date.now() + 60000
          this.locationRequest = undefined
        })
    return this.locationRequest
  }
  async checkBatch(request: RegionalRequest): Promise<RegionalResponse> {
    if (
      request.version !== 1 ||
      !/^[a-zA-Z0-9_.:-]{1,160}$/.test(request.runId) ||
      !/^[a-f0-9]{64}$/.test(request.configVersion) ||
      !Array.isArray(request.monitors) ||
      !request.monitors.length ||
      request.monitors.length > MAX_REGIONAL_BATCH ||
      new Set(request.monitors.map((m) => m.id)).size !== request.monitors.length
    )
      throw new Error('Invalid regional request')
    if (this.queue.pendingCount + request.monitors.length > 160)
      throw new Error('Regional queue full')
    // The fingerprint covers all private check options; changed configurations cannot reuse stale settings.
    const serialized = JSON.stringify(request.monitors)
    if (new TextEncoder().encode(serialized).byteLength > 512 * 1024)
      throw new Error('Regional configuration too large')
    const hash = Array.from(
      new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized))),
      (b) => b.toString(16).padStart(2, '0')
    ).join('')
    if (hash !== request.configVersion)
      throw new Error('Regional configuration fingerprint mismatch')
    this.configurations.delete(hash)
    this.configurations.set(hash, request.monitors)
    while (this.configurations.size > 4)
      this.configurations.delete(this.configurations.keys().next().value!)
    const results = await Promise.all(
      this.configurations.get(hash)!.map((monitor) =>
        this.queue(async () => ({
          id: monitor.id,
          location: await this.getLocation(),
          status: await this.check({
            ...monitor,
            checkProxy: undefined,
            checkProxyHeaders: undefined,
          }),
        }))
      )
    )
    return { version: 1, runId: request.runId, configVersion: hash, results }
  }
}

const rootQueue = pLimit(5)
export async function checkMonitors(
  monitors: MonitorTarget[],
  location: string,
  env: Env,
  check = doMonitor
): Promise<CheckResult[]> {
  const groups = new Map<string, MonitorTarget[]>(),
    output: CheckResult[] = []
  const local: MonitorTarget[] = []
  for (const monitor of monitors) {
    if (check === doMonitor && monitor.checkProxy?.startsWith('worker://')) {
      const region = monitor.checkProxy.slice('worker://'.length)
      const group = groups.get(region) ?? []
      group.push(monitor)
      groups.set(region, group)
    } else local.push(monitor)
  }
  await Promise.all([
    ...local.map((monitor) =>
      rootQueue(async () => {
        try {
          const result = await check(monitor, location, env)
          if (!['proxy', 'configuration'].includes(result.status.stage ?? '')) output.push(result)
        } catch {
          /* System failures leave a gap rather than poisoning independent results. */
        }
      })
    ),
    ...Array.from(groups, async ([region, targets]) => {
      for (let offset = 0; offset < targets.length; offset += MAX_REGIONAL_BATCH) {
        const batch = targets.slice(offset, offset + MAX_REGIONAL_BATCH)
        const configVersion = Array.from(
          new Uint8Array(
            await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(batch)))
          ),
          (b) => b.toString(16).padStart(2, '0')
        ).join('')
        const request: RegionalRequest = {
          version: 1,
          runId: crypto.randomUUID(),
          configVersion,
          monitors: batch,
        }
        try {
          const stub = env.REMOTE_CHECKER_DO.get(
            env.REMOTE_CHECKER_DO.idFromName('region:' + region),
            { locationHint: region as DurableObjectLocationHint }
          )
          const deadline = Math.min(
            300000,
            Math.ceil(batch.length / 5) * Math.max(...batch.map((m) => m.timeout ?? 5000)) + 5000
          )
          const response = await withTimeout(deadline, stub.checkBatch(request))
          output.push(
            ...validateRegionalResponse(response, request).filter(
              (result) => !['proxy', 'configuration'].includes(result.status.stage ?? '')
            )
          )
        } catch {
          if (batch.some((m) => m.checkProxyFallback))
            output.push(
              ...(await checkMonitors(
                batch
                  .filter((m) => m.checkProxyFallback)
                  .map((m) => ({ ...m, checkProxy: undefined })),
                location,
                env,
                check
              ))
            )
        }
      }
    }),
  ])
  return output
}
