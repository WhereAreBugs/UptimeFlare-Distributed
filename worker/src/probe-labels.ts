import type { ProbeEnv } from './probes'
import type { ProbeDefinition } from '../../types/probes'

export const CLOUDFLARE_PROBE_ID = 'cloudflare'
export const CLOUDFLARE_PROBE: ProbeDefinition = { id: CLOUDFLARE_PROBE_ID }
export type ProbeNetwork = {
  country?: unknown
  region?: unknown
  city?: unknown
  asn?: unknown
}

function label(value: unknown): string {
  return typeof value === 'string' && value.length <= 100 && !/[\u0000-\u001f\u007f]/.test(value)
    ? value.trim()
    : ''
}

export async function saveProbeLabel(env: ProbeEnv, id: string, name: string, location: string) {
  return env.UPTIMEFLARE_D1.prepare(
    `INSERT INTO probe_metadata (probe_id, default_name, default_location) VALUES (?, ?, ?)
    ON CONFLICT(probe_id) DO UPDATE SET default_name=excluded.default_name,
      default_location=excluded.default_location
    WHERE probe_metadata.default_name<>excluded.default_name
      OR probe_metadata.default_location<>excluded.default_location`
  )
    .bind(id, name, location)
    .run()
}

/** Only Cloudflare's request context supplies this data; never accept client headers/body. */
export function probeNetworkLabel(cf?: ProbeNetwork) {
  if (!cf || !Number.isInteger(cf.asn) || Number(cf.asn) < 1 || Number(cf.asn) > 4294967295) return
  const parts = [cf.country, cf.region, cf.city].map(label).filter(Boolean)
  const location = Array.from(new Set(parts)).join(' / ')
  if (!location) return // Missing platform metadata must not erase previously detected labels.
  return { name: `${location} · AS${cf.asn}`, location }
}
export async function recordProbeNetwork(env: ProbeEnv, id: string, cf?: ProbeNetwork) {
  const detected = probeNetworkLabel(cf)
  if (detected) return saveProbeLabel(env, id, detected.name, detected.location)
}

export async function getProbeDefinitions(env: ProbeEnv, probes: ProbeDefinition[]) {
  const definitions = probes.some((p) => p.id === CLOUDFLARE_PROBE_ID)
    ? probes
    : [...probes, CLOUDFLARE_PROBE]
  if (definitions.length > 33) throw new Error('Too many probe definitions')
  const rows = await env.UPTIMEFLARE_D1.prepare(
    'SELECT * FROM probe_metadata WHERE probe_id IN (SELECT value FROM json_each(?))'
  )
    .bind(JSON.stringify(definitions.map((p) => p.id)))
    .all<{
      probe_id: string
      default_name: string
      default_location: string
    }>()
  const labels = new Map(rows.results.map((row) => [row.probe_id, row]))
  return definitions.map((probe) => {
    const detected = labels.get(probe.id)
    return {
      ...probe,
      defaultName:
        detected?.default_name ||
        (probe.id === CLOUDFLARE_PROBE_ID ? 'Cloudflare · AS13335' : probe.id),
      defaultLocation:
        detected?.default_location || (probe.id === CLOUDFLARE_PROBE_ID ? 'Cloudflare edge' : ''),
    }
  })
}
