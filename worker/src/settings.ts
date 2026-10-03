import type { WorkerConfig } from '../../types/config'
import type { ProbeEnv } from './probes'
import { getProbeDefinitions } from './probe-labels'

export type EditableSettings = Pick<WorkerConfig, 'monitors' | 'probes' | 'probeStaleAfterSeconds'>
export type StoredSettings = EditableSettings & { revision: number }

/** Read once per request; D1 is the authoritative source after the first admin save. */
export async function getSettings(env: ProbeEnv, fallback: WorkerConfig): Promise<StoredSettings> {
  const row = await env.UPTIMEFLARE_D1.prepare(
    'SELECT revision, value FROM admin_config WHERE id = 1'
  ).first<{ revision: number; value: string }>()
  const settings: StoredSettings = row
    ? { ...JSON.parse(row.value), revision: row.revision }
    : {
        revision: 0,
        monitors: fallback.monitors,
        probes: fallback.probes ?? [],
        probeStaleAfterSeconds: fallback.probeStaleAfterSeconds ?? 900,
      }
  return { ...settings, probes: await getProbeDefinitions(env, settings.probes ?? []) }
}

export async function getRuntimeConfig(
  env: ProbeEnv,
  fallback: WorkerConfig
): Promise<WorkerConfig> {
  return { ...fallback, ...(await getSettings(env, fallback)) }
}
