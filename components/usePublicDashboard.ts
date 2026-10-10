import { decodePublicWire } from '@/util/public-wire'
import { useEffect, useState } from 'react'
import type { PublicDashboard } from '@/types/public-dashboard'
import { PUBLIC_CLIENT_REFRESH_SECONDS } from '@/types/public-dashboard'

/** One cancellable summary request, bounded exponential retry and no hidden-tab polling. */
export function usePublicDashboard() {
  const [dashboard, setDashboard] = useState<PublicDashboard | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    let stopped = false
    let failures = 0
    let timer: ReturnType<typeof setTimeout> | undefined
    let controller: AbortController | undefined
    const refresh = async () => {
      if (stopped || document.hidden || controller) return
      controller = new AbortController()
      const current = controller
      const deadline = setTimeout(() => current.abort(), 10000)
      let delay = PUBLIC_CLIENT_REFRESH_SECONDS * 1000
      try {
        const response = await fetch('/api/state', { signal: current.signal, cache: 'default' })
        if (!response.ok) throw new Error('State unavailable')
        const raw: any = await response.json()
        const value = {
          ...decodePublicWire(raw),
          ...{
            source: raw.source,
            snapshotAt: raw.snapshotAt,
            stale: raw.stale,
            snapshotIncomplete: raw.snapshotIncomplete,
            materializedAt: raw.materializedAt,
            cachedAt: raw.cachedAt,
          },
        } as PublicDashboard
        if (value.monitors.some((monitor) => !monitor.paused && monitor.intervalSeconds < 300))
          delay = 60000
        if (!stopped && !current.signal.aborted) {
          setDashboard(value)
          setError(false)
          failures = 0
        }
      } catch {
        if (!stopped && !document.hidden) {
          setError(true)
          delay = Math.min(300000, 2000 * 2 ** Math.min(8, failures++))
        }
      } finally {
        clearTimeout(deadline)
        controller = undefined
        if (!stopped && !document.hidden) timer = setTimeout(refresh, delay)
      }
    }
    const visibility = () => {
      clearTimeout(timer)
      if (document.hidden) controller?.abort()
      else void refresh()
    }
    void refresh()
    document.addEventListener('visibilitychange', visibility)
    return () => {
      stopped = true
      clearTimeout(timer)
      controller?.abort()
      document.removeEventListener('visibilitychange', visibility)
    }
  }, [])
  return { dashboard, error }
}
