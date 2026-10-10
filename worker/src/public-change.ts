import type { ProbeResult } from '../../types/probes'

/** A bounded hint only, never authoritative state or a reason to discard a sample.
 * Repeated failures and delayed backlog do not cause repeated early publication. */
export class PublicChanges {
  private latest = new Map<string, { time: number; signature: string }>()
  observe(probe: string, results: ProbeResult[], now: number) {
    let changed = false
    for (const sample of results) {
      if (sample.time < now - 600 || ['proxy', 'configuration'].includes(sample.stage ?? ''))
        continue
      const key = probe + '\0' + sample.monitor_id
      const before = this.latest.get(key)
      if (before && sample.time <= before.time) continue
      const signature = sample.up ? 'up' : `${sample.stage ?? ''}/${sample.code ?? ''}`
      changed ||= before ? before.signature !== signature : !sample.up
      this.latest.delete(key)
      this.latest.set(key, { time: sample.time, signature })
      if (this.latest.size > 4096) this.latest.delete(this.latest.keys().next().value!)
    }
    return changed
  }
}
