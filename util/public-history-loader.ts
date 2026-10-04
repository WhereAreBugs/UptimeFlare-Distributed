import type { ProbeMonitorSummary } from '../types/probes'

export type PublicHistory = {
  monitorId: string
  summary?: ProbeMonitorSummary
  compactedStateStr?: string | null
  historyLoaded?: boolean
}

/** Two requests at a time, de-duplicated, with a bounded cache shared by visible cards. */
export function createPublicHistoryLoader(
  fetchHistory: (id: string, signal: AbortSignal) => Promise<PublicHistory>,
  capacity = 24,
  clock = Date.now
) {
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error('Invalid history cache capacity')
  const cache = new Map<
    string,
    { value: PublicHistory; version: number | string | null; time: number }
  >()
  type Entry = {
    promise: Promise<PublicHistory>
    controller: AbortController
    subscribers: number
    permanent: boolean
    start: () => void
  }
  const pending = new Map<string, Entry>(),
    queue: (() => void)[] = []
  let running = 0
  const canceled = () =>
    Object.assign(new Error('History request canceled'), { name: 'AbortError' })
  const pump = () => {
    while (running < 2 && queue.length) queue.shift()!()
  }
  function subscribe(entry: Entry, signal?: AbortSignal) {
    if (!signal) {
      entry.permanent = true
      return entry.promise
    }
    entry.subscribers++
    return new Promise<PublicHistory>((resolve, reject) => {
      let done = false
      const finish = (value?: PublicHistory, error?: unknown) => {
        if (done) return
        done = true
        signal.removeEventListener('abort', abort)
        entry.subscribers--
        if (!entry.subscribers && !entry.permanent) entry.controller.abort()
        if (error) reject(error)
        else resolve(value!)
      }
      const abort = () => finish(undefined, canceled())
      if (signal.aborted) abort()
      else signal.addEventListener('abort', abort, { once: true })
      entry.promise.then(
        (value) => finish(value),
        (error) => finish(undefined, error)
      )
    })
  }
  return {
    load(id: string, version: number | string | null, signal?: AbortSignal) {
      if (signal?.aborted) return Promise.reject(canceled())
      const saved = cache.get(id)
      if (saved && saved.version === version && clock() - saved.time < 300000) {
        cache.delete(id)
        cache.set(id, saved)
        return Promise.resolve(saved.value)
      }
      const existing = pending.get(id)
      if (existing && !existing.controller.signal.aborted) return subscribe(existing, signal)
      if (queue.length >= 64) return Promise.reject(new Error('History request queue full'))
      const controller = new AbortController()
      let resolve!: (value: PublicHistory) => void, reject!: (error: unknown) => void
      const promise = new Promise<PublicHistory>((yes, no) => {
        resolve = yes
        reject = no
      })
      const entry: Entry = {
        promise,
        controller,
        subscribers: 0,
        permanent: false,
        start: () => {
          if (controller.signal.aborted) {
            reject(canceled())
            return
          }
          running++
          void Promise.resolve()
            .then(() => fetchHistory(id, controller.signal))
            .then((value) => {
              if (controller.signal.aborted) throw canceled()
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
              if (pending.get(id) === entry) pending.delete(id)
              pump()
            })
        },
      }
      controller.signal.addEventListener(
        'abort',
        () => {
          const position = queue.indexOf(entry.start)
          if (position >= 0) queue.splice(position, 1)
          if (pending.get(id) === entry) pending.delete(id)
          reject(canceled())
          pump()
        },
        { once: true }
      )
      pending.set(id, entry)
      queue.push(entry.start)
      const result = subscribe(entry, signal)
      pump()
      return result
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
