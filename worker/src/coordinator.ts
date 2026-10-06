import { invocation, observe } from './telemetry'
import { withResources } from './resources'
import { DurableObject } from 'cloudflare:workers'
import pLimit from 'p-limit'
import type { Env } from './index'
import type { ProbeResult } from '../../types/probes'
import type { ScheduledClaim } from './scheduling'
import type { CheckResult } from './regional'
import { persistPackedBatch } from './packed-probes'
import { commitNativeV2, type NativeEffect } from './native-v2'
import { getRuntimeConfig } from './settings'
import { workerConfig } from '../../uptime.config'
import { publishPublicDashboard } from './public-dashboard'
import { runNotifications } from './notifications'
import { cleanupPackedProbeResults } from './probe-retention'

export const COORDINATOR_PROTOCOL = 1
export type ProbeCommitRequest = {
  version: 1
  runId: string
  probeId: string
  results: ProbeResult[]
  gate?: { scope: string; key: string }
}
export type NativeCommitRequest = {
  version: 1
  configRevision: number
  claim: ScheduledClaim
  results: CheckResult[]
}

/** Stable object identity. Measurement never holds this queue; network delivery stays in the root. */
export class Coordinator extends DurableObject<Env> {
  private queue = pLimit(1)
  async versions() {
    return { schema: 2, coordinator: 1, regional: 1, probe: 1 }
  }
  private async serial<T>(
    name: string,
    parent: string | undefined,
    work: (env: Env) => Promise<T>
  ) {
    if (this.env.STATE_STORAGE_VERSION !== '2')
      throw new Error('Coordinator requires migrated schema2')
    if (this.queue.pendingCount >= 64) throw new Error('Coordinator queue full; retry the same run')
    const start = performance.now()
    return invocation(
      this.env,
      'coordinator.' + name,
      () =>
        this.queue(() => {
          observe(
            'worker.coordinator.queue.wait',
            performance.now() - start,
            { operation: name },
            true
          )
          observe(
            'worker.coordinator.queue.pending',
            this.queue.pendingCount,
            { operation: name },
            true
          )
          return withResources(this.env, 'coordinator', work)
        }),
      { parent, waitUntil: (p) => this.ctx.waitUntil(p) }
    )
  }

  async commitProbe(request: ProbeCommitRequest, parent?: string) {
    if (
      request.version !== COORDINATOR_PROTOCOL ||
      !request.results?.length ||
      request.results.length > 200 ||
      new TextEncoder().encode(JSON.stringify(request)).byteLength > 512 * 1024
    )
      throw new Error('Unsupported probe coordination request')
    return this.serial('commitProbe', parent, async (env) => {
      await persistPackedBatch(
        env,
        request.probeId,
        request.results,
        request.runId,
        [],
        request.gate
      )
      return { version: 1, runId: request.runId, committed: true }
    })
  }
  async commitNative(
    request: NativeCommitRequest,
    parent?: string
  ): Promise<{ version: number; committed: boolean; effects?: NativeEffect[] }> {
    if (request.version !== COORDINATOR_PROTOCOL || request.results.length > 200)
      throw new Error('Unsupported native coordination request')
    return this.serial('commitNative', parent, async (env) => {
      const config = await getRuntimeConfig(env, workerConfig)
      if (
        ((config as typeof config & { revision?: number }).revision ?? 0) !== request.configRevision
      )
        return { version: 1, committed: false }
      const effects: NativeEffect[] = []
      const committed = await commitNativeV2(env, config, request.claim, request.results, effects)
      return { version: 1, committed, effects }
    })
  }
  async status(runId: string) {
    if (!/^[a-zA-Z0-9_.:-]{1,200}$/.test(runId)) throw new Error('Invalid run identity')
    const receipt = await this.env.UPTIMEFLARE_D1.prepare(
      'SELECT protocol,committed_at FROM commit_runs WHERE run_id=?'
    )
      .bind(runId)
      .first()
    return { version: 1, runId, committed: !!receipt }
  }
  async materialize(time: number, parent?: string) {
    return this.serial('materialize', parent, async (env) =>
      publishPublicDashboard(env, await getRuntimeConfig(env, workerConfig), time)
    )
  }
  async evaluate(now: number, parent?: string) {
    return this.serial('evaluate', parent, async (env) =>
      runNotifications(env, await getRuntimeConfig(env, workerConfig), now, undefined, false)
    )
  }
  async cleanup(now: number, parent?: string) {
    return this.serial('cleanup', parent, (env) => cleanupPackedProbeResults(env, now))
  }
}
