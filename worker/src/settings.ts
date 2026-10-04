import type { WorkerConfig } from '../../types/config'
import type { ProbeEnv } from './probes'
import { getProbeDefinitions } from './probe-labels'
import { pageConfig, maintenances } from '../../uptime.config'
import { projectGroupIds } from './groups'

export type EditableSettings = Pick<WorkerConfig, 'monitors' | 'probes' | 'notificationTemplates' | 'page' | 'maintenances' | 'notification'>
export type StoredSettings = EditableSettings & { revision: number; groupIds: Record<string, string> }

/** Read once per request; D1 is the authoritative source after the first admin save. */
export async function getSettings(env: ProbeEnv, fallback: WorkerConfig): Promise<StoredSettings> {
  const row = await env.UPTIMEFLARE_D1.prepare(
    'SELECT revision, value FROM admin_config WHERE id = 1'
  ).first<{ revision: number; value: string }>()
  const settings = row
    ? { ...JSON.parse(row.value), revision: row.revision }
    : {
        revision: 0,
        monitors: fallback.monitors,
        probes: fallback.probes ?? [],
        notificationTemplates: fallback.notificationTemplates ?? [],
      }
  return {
    revision: settings.revision,
    groupIds: projectGroupIds(settings.page ?? fallback.page ?? pageConfig, settings._groupIds),
    monitors: settings.monitors,
    notificationTemplates: settings.notificationTemplates ?? [],
    page: settings.page ?? fallback.page ?? pageConfig,
    maintenances: settings.maintenances ?? fallback.maintenances ?? maintenances,
    notification: settings.notification ?? fallback.notification ?? {},
    probes: await getProbeDefinitions(env, settings.probes ?? []),
  }
}

export async function getRuntimeConfig(
  env: ProbeEnv,
  fallback: WorkerConfig
): Promise<WorkerConfig> {
  // Older saved/source configurations may contain the retired global TTL. Ignore
  // it without rewriting settings, changing the revision, or touching credentials.
  const { probeStaleAfterSeconds: _legacy, ...base } = fallback as WorkerConfig & {
    probeStaleAfterSeconds?: unknown
  }
  const settings = await getSettings(env, fallback)
  return { ...base, ...settings, notification: { ...base.notification, ...settings.notification } }
}
