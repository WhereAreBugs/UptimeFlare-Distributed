import Head from 'next/head'

import { Inter } from 'next/font/google'
import { MonitorTarget, PageConfig, MaintenanceConfig } from '@/types/config'
import { maintenances as initialMaintenances, pageConfig as initialPage } from '@/uptime.config'
import OverallStatus from '@/components/OverallStatus'
import Header from '@/components/Header'
import MonitorList from '@/components/MonitorList'
import { Text } from '@mantine/core'
import MonitorDetail from '@/components/MonitorDetail'
import Footer from '@/components/Footer'
import { useTranslation } from 'react-i18next'
import { CompactedMonitorStateWrapper, getFromStore } from '@/worker/src/store'
import { getProbeSummaries } from '@/worker/src/probes'
import type { ProbeMonitorSummary } from '@/types/probes'
import { summarizeMonitors } from '@/util/probe-status'
import { useEffect, useMemo, useState } from 'react'
import { useRouter } from 'next/router'
import { getMonitorIntervalSeconds } from '@/util/monitor-settings'
import { expandMaintenances, getPresentationSettings } from '@/util/maintenance'

export const runtime = 'experimental-edge'
const inter = Inter({ subsets: ['latin'] })

export default function Home({
  compactedStateStr,
  monitors,
  probeSummaries = {},
  page = initialPage,
  maintenances: plans = initialMaintenances,
}: {
  compactedStateStr: string | null
  monitors: MonitorTarget[]
  probeSummaries?: Record<string, ProbeMonitorSummary>
  page?: PageConfig
  maintenances?: MaintenanceConfig[]
}) {
  const { t } = useTranslation('common')
  const router = useRouter()
  const state = useMemo(
    () => new CompactedMonitorStateWrapper(compactedStateStr).uncompact(),
    [compactedStateStr]
  )
  const [now, setNow] = useState(() => Math.round(Date.now() / 1000))
  const [monitorId, setMonitorId] = useState('')
  const windowMinute = Math.floor(now / 60)
  const maintenances = useMemo(() => expandMaintenances(plans, windowMinute * 60 - 7 * 86400, windowMinute * 60 + 30 * 86400), [plans, windowMinute])
  useEffect(() => {
    const updateHash = () => setMonitorId(window.location.hash.substring(1))
    updateHash()
    window.addEventListener('hashchange', updateHash)
    const timer = setInterval(() => setNow(Math.round(Date.now() / 1000)), 15000)
    return () => {
      window.removeEventListener('hashchange', updateHash)
      clearInterval(timer)
    }
  }, [])
  useEffect(() => {
    if (!router.isReady) return
    let refreshing = false
    const refresh = async () => {
      if (document.hidden || refreshing) return
      refreshing = true
      try {
        await router.replace(router.asPath, undefined, { scroll: false })
      } catch {
        // A failed page refresh must not erase the last available history.
      } finally {
        refreshing = false
      }
    }
    const onVisible = () => {
      if (!document.hidden) void refresh()
    }
    const refreshEverySeconds = Math.min(300, ...monitors.map(getMonitorIntervalSeconds))
    const timer = setInterval(() => void refresh(), refreshEverySeconds * 1000)
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [router, monitors])
  const aggregate = summarizeMonitors(monitors, state, probeSummaries, now)

  // Specify monitorId in URL hash to view a specific monitor (can be used in iframe)
  if (monitorId) {
    const monitor = monitors.find((monitor) => monitor.id === monitorId)
    if (!monitor || !state) {
      return <Text fw={700}>{t('Probe monitor unavailable')}</Text>
    }
    return (
      <div style={{ maxWidth: '810px' }}>
        <MonitorDetail monitor={monitor} state={state} probeSummaries={probeSummaries} now={now} maintenances={maintenances} />
      </div>
    )
  }

  return (
    <>
      <Head>
        <title>{page.title}</title>
        <link rel="icon" href={page.favicon ?? '/favicon.png'} />
      </Head>

      <main className={inter.className}>
        <Header page={page} />

        <div>
          <OverallStatus
            state={state}
            monitors={monitors}
            maintenances={maintenances}
            aggregate={aggregate}
            page={page}
          />
          <MonitorList
            monitors={monitors}
            state={state}
            probeSummaries={probeSummaries}
            now={now}
            page={page}
            maintenances={maintenances}
          />
        </div>

        <Footer page={page} />
      </main>
    </>
  )
}

export async function getServerSideProps() {
  const { workerConfig: fallbackConfig } = await import('@/uptime.config')
  const { getRuntimeConfig } = await import('@/worker/src/settings')
  const workerConfig = await getRuntimeConfig(process.env as any, fallbackConfig)
  // Read state as string from storage, to avoid hitting server-side cpu time limit
  const [compactedStateStr, probeSummaries] = await Promise.all([
    getFromStore(process.env as any, 'state'),
    getProbeSummaries(
      process.env as any,
      workerConfig.monitors,
      workerConfig.probes,
      Math.round(Date.now() / 1000)
    ),
  ])

  // Only present these values to client
  const monitors = workerConfig.monitors.map((monitor) => {
    return {
      id: monitor.id,
      name: monitor.name,
      intervalSeconds: getMonitorIntervalSeconds(monitor),
      ...(monitor.tooltip !== undefined && { tooltip: monitor.tooltip }),
      ...(monitor.statusPageLink !== undefined && { statusPageLink: monitor.statusPageLink }),
      ...(monitor.hideLatencyChart !== undefined && { hideLatencyChart: monitor.hideLatencyChart }),
      ...(monitor.probes?.length && { probes: monitor.probes }),
    }
  })

  return {
    props: {
      compactedStateStr,
      monitors,
      probeSummaries,
      ...getPresentationSettings(workerConfig),
    },
  }
}
