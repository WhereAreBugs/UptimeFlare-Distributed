import Head from 'next/head'
import { Inter } from 'next/font/google'
import type { MaintenanceConfig, MonitorTarget, PageConfig } from '@/types/config'
const fallbackMaintenances: MaintenanceConfig[] = []
const pageConfig: PageConfig = { title: 'Status' }
import Header from '@/components/Header'
import {
  Alert,
  Box,
  Button,
  Center,
  Container,
  Group,
  Select,
  Stack,
  Table,
  Text,
} from '@mantine/core'
import Footer from '@/components/Footer'
import { useEffect, useRef, useState } from 'react'
import MaintenanceAlert from '@/components/MaintenanceAlert'
import NoIncidentsAlert from '@/components/NoIncidents'
import { useTranslation } from 'react-i18next'
import { usePublicDashboard } from '@/components/usePublicDashboard'

import type { NativeIncidentPage, ProbeIncidentPage } from '@/types/probes'
import { expandMaintenances } from '@/util/maintenance'

type HistoryPage = { probes: ProbeIncidentPage | null; native: NativeIncidentPage | null }

const inter = Inter({ subsets: ['latin'] })

function currentMonth() {
  return new Date().toISOString().slice(0, 7)
}
function selectedMonthFromHash() {
  const hash = typeof window === 'undefined' ? '' : window.location.hash.slice(1)
  return /^\d{4}-(0[1-9]|1[0-2])(?:-|$)/.test(hash) ? hash.slice(0, 7) : currentMonth()
}
function monthRange(month: string) {
  const [year, value] = month.split('-').map(Number)
  return {
    from: Math.floor(Date.UTC(year, value - 1, 1) / 1000),
    to: Math.floor(Date.UTC(year, value, 1) / 1000),
  }
}
function neighboringMonth(month: string, offset: number) {
  const [year, value] = month.split('-').map(Number)
  return new Date(Date.UTC(year, value - 1 + offset, 1)).toISOString().slice(0, 7)
}
function historyURL(month: string, monitor: string | null, kind = 'all', cursor?: string) {
  const range = monthRange(month)
  const search = new URLSearchParams({ from: String(range.from), to: String(range.to), kind })
  if (monitor) search.set('monitor', monitor)
  if (cursor) search.set(kind === 'native' ? 'nativeCursor' : 'cursor', cursor)
  return `/api/incidents?${search}`
}

function IncidentsPage({
  monitors,
  page = pageConfig,
  maintenances = fallbackMaintenances,
  initialHistory = { probes: null, native: null },
  initialMonitor = '',
  initialMonth = currentMonth(),
}: {
  monitors: MonitorTarget[]
  page?: PageConfig
  maintenances?: MaintenanceConfig[]
  initialHistory?: HistoryPage
  initialMonitor?: string
  initialMonth?: string
}) {
  const { t } = useTranslation('common')
  const [selectedMonitor, setSelectedMonitor] = useState<string | null>(initialMonitor)
  const [selectedMonth, setSelectedMonth] = useState(initialMonth)
  const [history, setHistory] = useState<HistoryPage>(initialHistory)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState<string | null>(null)
  const [error, setError] = useState(false)
  const initialKey = useRef('')
  const currentSelection = useRef(`${selectedMonth}\0${selectedMonitor || ''}`)
  currentSelection.current = `${selectedMonth}\0${selectedMonitor || ''}`

  useEffect(() => {
    const onHashChange = () => setSelectedMonth(selectedMonthFromHash())
    onHashChange()
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  useEffect(() => {
    const key = `${selectedMonth}\0${selectedMonitor || ''}`
    if (initialKey.current === key) {
      initialKey.current = ''
      return
    }
    const controller = new AbortController()
    const range = monthRange(selectedMonth)
    setError(false)
    setHistory({ probes: null, native: null })
    setLoadingMore(null)
    setLoading(false)
    if (range.to <= Date.now() / 1000 - 90 * 86400 || range.from > Date.now() / 1000) return
    setLoading(true)
    fetch(historyURL(selectedMonth, selectedMonitor), { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('History failed')
        return response.json()
      })
      .then((value) => setHistory(value as HistoryPage))
      .catch((failure) => {
        if (failure.name !== 'AbortError') setError(true)
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false)
      })
    return () => controller.abort()
  }, [selectedMonth, selectedMonitor])

  async function loadMore(kind: 'probes' | 'native') {
    const cursor = history[kind]?.nextCursor
    if (!cursor) return
    const key = `${selectedMonth}\0${selectedMonitor || ''}`
    setLoadingMore(kind)
    setError(false)
    try {
      const response = await fetch(historyURL(selectedMonth, selectedMonitor, kind, cursor))
      if (!response.ok) throw new Error('History failed')
      const value: HistoryPage = await response.json()
      // Ignore a response for a previous selection.
      if (key !== currentSelection.current) return
      setHistory((previous) =>
        kind === 'probes'
          ? {
              ...previous,
              probes: {
                ...value.probes!,
                failures: [...(previous.probes?.failures ?? []), ...value.probes!.failures],
              },
            }
          : {
              ...previous,
              native: {
                ...value.native!,
                incidents: [...(previous.native?.incidents ?? []), ...value.native!.incidents],
              },
            }
      )
    } catch {
      if (key === currentSelection.current) setError(true)
    } finally {
      if (key === currentSelection.current) setLoadingMore(null)
    }
  }

  const range = monthRange(selectedMonth)
  const published = expandMaintenances(maintenances, range.from, range.to)
    .filter(
      (entry) =>
        !selectedMonitor || !entry.monitors?.length || entry.monitors.includes(selectedMonitor)
    )
    .sort((a, b) => new Date(b.start).getTime() - new Date(a.start).getTime())
    .map((entry) => ({
      ...entry,
      monitors: (entry.monitors?.length ? entry.monitors : monitors.map((monitor) => monitor.id))
        .map((id) => monitors.find((monitor) => monitor.id === id))
        .filter((monitor): monitor is MonitorTarget => !!monitor),
    }))
  const failures = history.probes?.failures ?? []
  const native = history.native?.incidents ?? []
  const time = (epoch: number) => new Date(epoch * 1000).toLocaleString()

  return (
    <>
      <Head>
        <title>{page.title}</title>
        <link rel="icon" href={page.favicon ?? '/favicon.png'} />
      </Head>
      <main className={inter.className}>
        <Header page={page} style={{ marginBottom: 40 }} />
        <Center>
          <Container size="md" style={{ width: '100%' }}>
            <Group justify="end" mb="md">
              <Select
                placeholder={t('Select monitor')}
                data={[
                  { value: '', label: t('All') },
                  ...monitors.map((monitor) => ({ value: monitor.id, label: monitor.name })),
                ]}
                value={selectedMonitor}
                onChange={setSelectedMonitor}
                clearable
                style={{ maxWidth: 300 }}
              />
            </Group>
            <Text size="sm" c="dimmed" mb="md">
              {t('Probe history retention explanation')}
            </Text>
            {error && (
              <Alert color="red" mb="md">
                {t('Probe history load error')}
              </Alert>
            )}
            {loading && <Text mb="md">{t('Probe history loading')}</Text>}
            {monitors.some((monitor) => monitor.probes?.length) && (
              <Box mb="xl">
                <Text fw={700} mb="xs">
                  {t('Probe failed checks heading')}
                </Text>
                <Text size="sm" c="dimmed" mb="sm">
                  {t('Probe failed check semantics')}
                </Text>
                {failures.length ? (
                  <div style={{ overflow: 'auto', maxHeight: 500 }}>
                    <Table striped highlightOnHover style={{ minWidth: 760 }}>
                      <Table.Thead>
                        <Table.Tr>
                          {[
                            'Probe time',
                            'Probe monitor',
                            'Probe name',
                            'Probe stage',
                            'Probe error code',
                            'Probe error detail',
                          ].map((key) => (
                            <Table.Th key={key}>{t(key)}</Table.Th>
                          ))}
                        </Table.Tr>
                      </Table.Thead>
                      <Table.Tbody>
                        {failures.map((failure) => (
                          <Table.Tr key={`${failure.monitorId}-${failure.probeId}-${failure.time}`}>
                            <Table.Td style={{ whiteSpace: 'nowrap' }}>
                              {time(failure.time)}
                            </Table.Td>
                            <Table.Td>
                              <a href={`/#${encodeURIComponent(failure.monitorId)}`}>
                                {failure.monitorName}
                              </a>
                            </Table.Td>
                            <Table.Td>{failure.probeName}</Table.Td>
                            <Table.Td>
                              {t(`Probe stage ${failure.stage}`, { defaultValue: failure.stage })}
                            </Table.Td>
                            <Table.Td>{failure.code}</Table.Td>
                            <Table.Td style={{ overflowWrap: 'anywhere' }}>
                              {failure.message}
                            </Table.Td>
                          </Table.Tr>
                        ))}
                      </Table.Tbody>
                    </Table>
                  </div>
                ) : (
                  !loading && (
                    <Text size="sm" c="dimmed">
                      {t('Probe no failed checks in month')}
                    </Text>
                  )
                )}
                {history.probes?.nextCursor && (
                  <Button
                    mt="sm"
                    variant="default"
                    loading={loadingMore === 'probes'}
                    onClick={() => loadMore('probes')}
                  >
                    {t('Probe load older events')}
                  </Button>
                )}
              </Box>
            )}
            {monitors.some((monitor) => !monitor.probes?.length) && (
              <Box mb="xl">
                <Text fw={700} mb="xs">
                  {t('Probe native incident heading')}
                </Text>
                <Text size="sm" c="dimmed" mb="sm">
                  {t('Probe native incident semantics')}
                </Text>
                <Stack gap="sm">
                  {native.map((incident) => (
                    <Box
                      key={`${incident.monitorId}-${incident.start}`}
                      p="sm"
                      style={{
                        border: '1px solid var(--mantine-color-default-border)',
                        borderRadius: 6,
                      }}
                    >
                      <Text fw={600}>
                        <a href={`/#${encodeURIComponent(incident.monitorId)}`}>
                          {incident.monitorName}
                        </a>
                      </Text>
                      <Text size="sm">
                        {time(incident.start)} —{' '}
                        {incident.end === null
                          ? t(
                              incident.stale
                                ? 'Probe incident awaiting report'
                                : 'Probe incident ongoing'
                            )
                          : time(incident.end)}
                        {incident.continued && ` · ${t('Probe incident continued')}`}
                      </Text>
                      {incident.reasons.map((reason, index) => (
                        <Text key={index} size="sm" style={{ overflowWrap: 'anywhere' }}>
                          {time(reason.time)} ·{' '}
                          {t(`Probe stage ${reason.stage}`, { defaultValue: reason.stage })} /{' '}
                          {reason.code} · {reason.message}
                        </Text>
                      ))}
                    </Box>
                  ))}
                </Stack>
                {!native.length && !loading && (
                  <Text size="sm" c="dimmed">
                    {t('Probe no native incidents')}
                  </Text>
                )}
                {history.native?.nextCursor && (
                  <Button
                    mt="sm"
                    variant="default"
                    loading={loadingMore === 'native'}
                    onClick={() => loadMore('native')}
                  >
                    {t('Probe load older events')}
                  </Button>
                )}
              </Box>
            )}
            <Text fw={700} mb="xs">
              {t('Probe published incidents')}
            </Text>
            {published.length ? (
              published.map((entry, index) => (
                <MaintenanceAlert key={index} maintenance={entry} page={page} />
              ))
            ) : (
              <NoIncidentsAlert />
            )}
            <Group justify="space-between" mt="md">
              <Button
                variant="default"
                onClick={() => {
                  window.location.hash = neighboringMonth(selectedMonth, -1)
                }}
              >
                {t('Backwards')}
              </Button>
              <Text fw={500} size="lg">
                {selectedMonth}
              </Text>
              <Button
                variant="default"
                onClick={() => {
                  window.location.hash = neighboringMonth(selectedMonth, 1)
                }}
              >
                {t('Forward')}
              </Button>
            </Group>
          </Container>
        </Center>
        <Footer page={page} />
      </main>
    </>
  )
}

export default function Incidents() {
  const { dashboard, error } = usePublicDashboard()
  if (!dashboard) return <Text p="md">{error ? '状态暂时不可用，正在重试…' : '正在加载…'}</Text>
  return (
    <IncidentsPage
      monitors={dashboard.monitors}
      page={dashboard.page}
      maintenances={dashboard.maintenances}
    />
  )
}
