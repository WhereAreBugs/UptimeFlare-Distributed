import { useEffect, useRef, useState } from 'react'
import { createPublicHistoryLoader, type PublicHistory } from '@/util/public-history-loader'

const loader = createPublicHistoryLoader(async (id, signal) => {
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) abort()
  const timer = setTimeout(() => controller.abort(), 10000)
  try {
    const response = await fetch(`/api/history?id=${encodeURIComponent(id)}`, {
      credentials: 'same-origin',
      cache: 'default',
      signal: controller.signal,
    })
    if (!response.ok) throw new Error('History is temporarily unavailable')
    return (await response.json()) as PublicHistory
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
})

export default function usePublicHistory(
  id: string,
  version: number | string | null,
  enabled: boolean,
  expanded: boolean,
  visible = true
) {
  const ref = useRef<HTMLDivElement>(null)
  const [inView, setInView] = useState(false)
  const [history, setHistory] = useState<PublicHistory | undefined>()
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!visible || !ref.current) return
    if (!('IntersectionObserver' in window)) {
      setInView(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => setInView(entries.some((entry) => entry.isIntersecting)),
      { rootMargin: '120px' }
    )
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [id, visible])
  useEffect(() => {
    if (!enabled || !(expanded || inView)) {
      setHistory(undefined)
      setFailed(false)
      return
    }
    let active = true
    const controller = new AbortController()
    setFailed(false)
    loader
      .load(id, version, controller.signal)
      .then((value) => {
        if (active) setHistory(value)
      })
      .catch(() => {
        if (active) setFailed(true)
      })
    return () => {
      active = false
      controller.abort()
    }
  }, [id, version, enabled, expanded, inView])
  return { ref, inView, history: history?.monitorId === id ? history : undefined, failed }
}
