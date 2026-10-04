import type { ProbeMonitorSummary } from '../types/probes'

export type PublicHistory = {
  monitorId: string
  summary?: ProbeMonitorSummary
  compactedStateStr?: string | null
  historyLoaded?: boolean
}

/** Two requests at a time, de-duplicated, with a bounded cache shared by visible cards. */
export function createPublicHistoryLoader(
  fetchHistory: (id: string) => Promise<PublicHistory>,
  capacity = 24,
  clock = Date.now
) {
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Invalid history cache capacity')
  const cache = new Map<
    string,
    { value: PublicHistory; version: number | string | null; time: number }
  >()
  const pending = new Map<string, Promise<PublicHistory>>()
  const queue: (() => void)[] = []
  let running = 0
  const pump = () => {
    while (running < 2 && queue.length) queue.shift()!()
  }
  return {
    load(id: string, version: number | string | null) {
      const saved = cache.get(id)
      if (saved && saved.version === version && clock() - saved.time < 300000) {
        cache.delete(id)
        cache.set(id, saved)
        return Promise.resolve(saved.value)
      }
      const key = id
      if (pending.has(key)) return pending.get(key)!
      const request = new Promise<PublicHistory>((resolve, reject) => {
        queue.push(() => {
          running++
          void Promise.resolve()
            .then(() => fetchHistory(id))
            .then((value) => {
              if (value.monitorId !== id || (!value.summary && !value.historyLoaded))
                throw new Error('Invalid monitor history')
              cache.delete(id)
              cache.set(id, { value, version, time: clock() })
              while (cache.size > capacity) cache.delete(cache.keys().next().value!)
              resolve(value)
            })
            .catch(reject)
            .finally(() => {
              running--
              pending.delete(key)
              pump()
            })
        })
      })
      pending.set(key, request)
      pump()
      return request
    },
  }
}

/** Fresh status comes from the light response; only history is retained from the lazy read. */
export function withProbeHistory(
  light: ProbeMonitorSummary | undefined,
  history?: ProbeMonitorSummary
) {
  if (!light || !history || light.monitorId !== history.monitorId) return light
  const full = new Map(history.probes.map((probe) => [probe.id, probe]))
  return {
    ...history,
    ...light,
    historyLoaded: true,
    dailyHistory: history.dailyHistory,
    retainedFrom: history.retainedFrom,
    probes: light.probes.map((probe) => {
      const saved = full.get(probe.id)
      if (!saved) return probe
      return {
        ...probe,
        ...(saved.latest === probe.latest &&
        saved.status === probe.status &&
        !probe.stale &&
        saved.message !== undefined
          ? { message: saved.message }
          : {}),
        history: saved.history,
        dailyHistory: saved.dailyHistory,
        recentFailures: saved.recentFailures,
        failureStages: saved.failureStages,
        avgLatencyMs: saved.avgLatencyMs,
        retainedFrom: saved.retainedFrom,
      }
    }),
  }
}
