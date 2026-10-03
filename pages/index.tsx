import Head from 'next/head'

import { Inter } from 'next/font/google'
import { MonitorTarget } from '@/types/config'
import { maintenances, pageConfig } from '@/uptime.config'
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

export const runtime = 'experimental-edge'
const inter = Inter({ subsets: ['latin'] })

export default function Home({
  compactedStateStr,
  monitors,
  probeSummaries = {},
  staleAfterSeconds = 900,
}: {
  compactedStateStr: string | null
  monitors: MonitorTarget[]
  probeSummaries?: Record<string, ProbeMonitorSummary>
  staleAfterSeconds?: number
}) {
  const { t } = useTranslation('common')
  const state = useMemo(
    () => new CompactedMonitorStateWrapper(compactedStateStr).uncompact(),
    [compactedStateStr]
  )
  const [now, setNow] = useState(() => Math.round(Date.now() / 1000))
  const [monitorId, setMonitorId] = useState('')
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
  const aggregate = summarizeMonitors(monitors, state, probeSummaries, now, staleAfterSeconds)

  // Specify monitorId in URL hash to view a specific monitor (can be used in iframe)
  if (monitorId) {
    const monitor = monitors.find((monitor) => monitor.id === monitorId)
    if (!monitor || !state) {
      return <Text fw={700}>{t('Probe monitor unavailable')}</Text>
    }
    return (
      <div style={{ maxWidth: '810px' }}>
        <MonitorDetail
          monitor={monitor}
          state={state}
          probeSummaries={probeSummaries}
          now={now}
          staleAfterSeconds={staleAfterSeconds}
        />
      </div>
    )
  }

  return (
    <>
      <Head>
        <title>{pageConfig.title}</title>
        <link rel="icon" href={pageConfig.favicon ?? '/favicon.png'} />
      </Head>

      <main className={inter.className}>
        <Header />

        <div>
          <OverallStatus
            state={state}
            monitors={monitors}
            maintenances={maintenances}
            aggregate={aggregate}
          />
          <MonitorList
            monitors={monitors}
            state={state}
            probeSummaries={probeSummaries}
            now={now}
            staleAfterSeconds={staleAfterSeconds}
          />
        </div>

        <Footer />
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
      Math.round(Date.now() / 1000),
      workerConfig.probeStaleAfterSeconds
    ),
  ])

  // Only present these values to client
  const monitors = workerConfig.monitors.map((monitor) => {
    return {
      id: monitor.id,
      name: monitor.name,
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
      staleAfterSeconds: workerConfig.probeStaleAfterSeconds ?? 900,
    },
  }
}
