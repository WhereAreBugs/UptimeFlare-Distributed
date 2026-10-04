import { useEffect, useState } from 'react'
import type { PublicDashboard } from '@/types/public-dashboard'

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
      let delay = 60000
      try {
        const response = await fetch('/api/state', { signal: current.signal, cache: 'no-store' })
        if (!response.ok) throw new Error('State unavailable')
        const value: PublicDashboard = await response.json()
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
