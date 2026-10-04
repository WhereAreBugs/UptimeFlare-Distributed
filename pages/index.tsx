import Head from 'next/head'

import { Inter } from 'next/font/google'
import { MonitorTarget, PageConfig, MaintenanceConfig } from '@/types/config'
const initialMaintenances: MaintenanceConfig[] = []
const initialPage: PageConfig = { title: 'Status' }
import OverallStatus from '@/components/OverallStatus'
import Header from '@/components/Header'
import MonitorList from '@/components/MonitorList'
import { Text } from '@mantine/core'
import MonitorDetail from '@/components/MonitorDetail'
import Footer from '@/components/Footer'
import { useTranslation } from 'react-i18next'
import { CompactedMonitorStateWrapper } from '@/worker/src/store'
import { usePublicDashboard } from '@/components/usePublicDashboard'
import { visiblePublicMonitors } from '@/util/public-monitor-list'
import type { ProbeMonitorSummary } from '@/types/probes'
import { summarizeDashboardMonitors } from '@/util/dashboard-status'
import { useEffect, useMemo, useState } from 'react'

import { expandMaintenances } from '@/util/maintenance'
import {
  guardPublicSnapshot,
  isPublicSnapshotUnavailable,
  type PublicSnapshotMetadata,
} from '@/util/public-snapshot'
import PublicSnapshotNotice from '@/components/PublicSnapshotNotice'

const inter = Inter({ subsets: ['latin'] })

function Dashboard({
  compactedStateStr,
  monitors,
  probeSummaries = {},
  page = initialPage,
  maintenances: plans = initialMaintenances,
  nativeHistoryLoaded = true,
  snapshotAt = null,
  stale = false,
  snapshotIncomplete = false,
  source = 'd1',
}: {
  compactedStateStr: string | null
  monitors: MonitorTarget[]
  probeSummaries?: Record<string, ProbeMonitorSummary>
  page?: PageConfig
  maintenances?: MaintenanceConfig[]
  nativeHistoryLoaded?: boolean
} & PublicSnapshotMetadata) {
  const { t } = useTranslation('common')

  const rawState = useMemo(
    () => new CompactedMonitorStateWrapper(compactedStateStr).uncompact(),
    [compactedStateStr]
  )
  const [now, setNow] = useState(() => Math.round(Date.now() / 1000))
  const snapshotUnavailable = isPublicSnapshotUnavailable(
    { snapshotAt, stale, snapshotIncomplete, source },
    now
  )
  const guarded = useMemo(
    () => guardPublicSnapshot(rawState, probeSummaries, snapshotUnavailable),
    [rawState, probeSummaries, snapshotUnavailable]
  )
  const state = guarded.state
  const summaries = guarded.summaries
  const [monitorId, setMonitorId] = useState('')
  const activeMonitors = useMemo(
    () => visiblePublicMonitors(monitors, summaries),
    [monitors, summaries]
  )
  const windowMinute = Math.floor(now / 60)
  const maintenances = useMemo(
    () => expandMaintenances(plans, windowMinute * 60 - 7 * 86400, windowMinute * 60 + 30 * 86400),
    [plans, windowMinute]
  )
  useEffect(() => {
    const updateHash = () => setMonitorId(window.location.hash.substring(1))
    updateHash()
    window.addEventListener('hashchange', updateHash)
    const updateTime = () => {
      if (!document.hidden) setNow(Math.round(Date.now() / 1000))
    }
    const timer = setInterval(updateTime, 60000)
    document.addEventListener('visibilitychange', updateTime)
    return () => {
      window.removeEventListener('hashchange', updateHash)
      clearInterval(timer)
      document.removeEventListener('visibilitychange', updateTime)
    }
  }, [])
  const aggregate = summarizeDashboardMonitors(monitors, state, summaries, maintenances, now)
  const snapshot = { snapshotAt, stale: snapshotUnavailable, snapshotIncomplete }

  // Specify monitorId in URL hash to view a specific monitor (can be used in iframe)
  if (monitorId) {
    const monitor = activeMonitors.find((monitor) => monitor.id === monitorId)
    if (!monitor || !state) {
      return <Text fw={700}>{t('Probe monitor unavailable')}</Text>
    }
    return (
      <div style={{ maxWidth: '810px' }}>
        <PublicSnapshotNotice {...snapshot} />
        <MonitorDetail
          monitor={monitor}
          state={state}
          probeSummaries={summaries}
          now={now}
          maintenances={maintenances}
          nativeHistoryLoaded={nativeHistoryLoaded}
          snapshotUnavailable={snapshotUnavailable}
        />
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
        <Header page={page} style={{ marginBottom: 0 }} />

        <div>
          <OverallStatus
            monitors={monitors}
            maintenances={maintenances}
            aggregate={aggregate}
            now={now}
            page={page}
            snapshot={snapshot}
          />
          <MonitorList
            monitors={monitors}
            state={state}
            probeSummaries={summaries}
            now={now}
            page={page}
            maintenances={maintenances}
            nativeHistoryLoaded={nativeHistoryLoaded}
            snapshotUnavailable={snapshotUnavailable}
          />
        </div>

        <Footer page={page} />
      </main>
    </>
  )
}

export default function Home() {
  const { dashboard, error } = usePublicDashboard()
  if (!dashboard) return <Text p="md">{error ? '状态暂时不可用，正在重试…' : '正在加载…'}</Text>
  return <Dashboard {...dashboard} nativeHistoryLoaded={false} />
}
