import type { ProbeEnv } from './probes'
import type { WorkerConfig } from '../../types/config'
import { getMonitorIntervalSeconds } from '../../util/monitor-settings'

export const PUBLICATION_KEY = 'public_snapshot_slot'
export const PUBLICATION_INTERVAL = 300
export const PUBLICATION_HEARTBEAT = 600
// Default targets need 288 normal slots; fast targets retain the two-minute
// cadence. The aggregate maximum is 964 reservations, including failed puts.
export const PUBLICATION_LIMITS = { scheduled: 720, event: 144, configuration: 100 } as const
export type PublicationKind = keyof typeof PUBLICATION_LIMITS
export type PublicationState = {
  day?: number
  scheduled?: number
  event?: number
  configuration?: number
  slot?: number
  attemptAt?: number
  pending?: string
  digest?: string
  publishedAt?: number
}
export const publicationInterval = (config?: WorkerConfig) =>
  config?.monitors.some((monitor) => !monitor.paused && getMonitorIntervalSeconds(monitor) < 300)
    ? 120
    : PUBLICATION_INTERVAL
export const isPublicationSlot = (time: number, config?: WorkerConfig) =>
  time % publicationInterval(config) === 0

export async function publicationState(env: ProbeEnv): Promise<PublicationState> {
  const row = await env.UPTIMEFLARE_D1.prepare('SELECT value FROM uptimeflare WHERE key=?')
    .bind(PUBLICATION_KEY)
    .first<{ value: string }>()
  if (!row) return {}
  const parsed = JSON.parse(row.value)
  // Existing installations stored a numeric two-minute slot. No migration is needed.
  return parsed && typeof parsed === 'object' ? parsed : {}
}

/** A single existing D1 key accounts for BOTH public KV keys, across isolates.
 * Failed/uncertain puts consume their reservation too: retries cannot overspend.
 * Fast targets can retain 720 slots; events and config have separate budgets. */
export async function reservePublication(
  env: ProbeEnv,
  kind: PublicationKind,
  time: number,
  now: number
): Promise<string | null> {
  const nonce = crypto.randomUUID(),
    day = Math.floor(now / 86400)
  const prior =
    "CASE WHEN json_valid(uptimeflare.value) AND json_type(uptimeflare.value)='object' THEN uptimeflare.value ELSE '{}' END"
  const sameDay = `COALESCE(json_extract(${prior},'$.day'),-1)=?`
  const base = `CASE WHEN ${sameDay} THEN ${prior} ELSE json_set(${prior},'$.day',?,'$.scheduled',0,'$.event',0,'$.configuration',0) END`
  const changes =
    kind === 'configuration'
      ? `json_set(${base},'$.configuration',COALESCE(json_extract(${base},'$.configuration'),0)+1)`
      : `json_set(${base},'$.${kind}',COALESCE(json_extract(${base},'$.${kind}'),0)+1,'$.pending',?,'$.attemptAt',?${
          kind === 'scheduled' ? ",'$.slot',?" : ''
        })`
  const condition =
    kind === 'configuration'
      ? ''
      : ` AND COALESCE(json_extract(${prior},'$.attemptAt'),0)<=?${
          kind === 'scheduled' ? ` AND COALESCE(json_extract(${prior},'$.slot'),-1)<?` : ''
        }`
  const initial = {
    day,
    [kind]: 1,
    ...(kind !== 'configuration' && {
      pending: nonce,
      attemptAt: now,
      ...(kind === 'scheduled' && { slot: time }),
    }),
  }
  const values: (string | number)[] = [PUBLICATION_KEY, JSON.stringify(initial), day, day, day, day]
  if (kind !== 'configuration') values.push(nonce, now, ...(kind === 'scheduled' ? [time] : []))
  values.push(day, PUBLICATION_LIMITS[kind])
  if (kind !== 'configuration') values.push(now - 60, ...(kind === 'scheduled' ? [time] : []))
  const row = await env.UPTIMEFLARE_D1.prepare(
    `INSERT INTO uptimeflare(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=${changes}
     WHERE (NOT (${sameDay}) OR COALESCE(json_extract(${prior},'$.${kind}'),0)<?)${condition} RETURNING key`
  )
    .bind(...values)
    .first()
  return row ? nonce : null
}

export async function finishPublication(env: ProbeEnv, nonce: string, digest: string, now: number) {
  await env.UPTIMEFLARE_D1.prepare(
    "UPDATE uptimeflare SET value=json_set(json_remove(value,'$.pending'),'$.digest',?,'$.publishedAt',?) WHERE key=? AND json_extract(value,'$.pending')=?"
  )
    .bind(digest, now, PUBLICATION_KEY, nonce)
    .run()
}
