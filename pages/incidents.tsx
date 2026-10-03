import Head from 'next/head'

import { Inter } from 'next/font/google'
import { MaintenanceConfig, MonitorTarget } from '@/types/config'
import { maintenances, pageConfig } from '@/uptime.config'
import Header from '@/components/Header'
import { Box, Button, Center, Container, Group, Select, Table, Text } from '@mantine/core'
import Footer from '@/components/Footer'
import { useEffect, useState } from 'react'
import MaintenanceAlert from '@/components/MaintenanceAlert'
import NoIncidentsAlert from '@/components/NoIncidents'
import { useTranslation } from 'react-i18next'
import { getProbeSummaries } from '@/worker/src/probes'
import type { ProbeFailure } from '@/types/probes'

type ProbeFailureRow = ProbeFailure & { monitorId: string; monitorName: string; probeName: string }

export const runtime = 'experimental-edge'
const inter = Inter({ subsets: ['latin'] })

function getSelectedMonth() {
  const hash = typeof window === 'undefined' ? '' : window.location.hash.replace('#', '')
  if (!hash) {
    const now = new Date()
    return now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0')
  }
  return /^\d{4}-(0[1-9]|1[0-2])(?:-|$)/.test(hash)
    ? hash.split('-').slice(0, 2).join('-')
    : new Date().toISOString().slice(0, 7)
}

function filterIncidentsByMonth(
  incidents: MaintenanceConfig[],
  monthStr: string,
  monitors: MonitorTarget[]
): (Omit<MaintenanceConfig, 'monitors'> & { monitors: MonitorTarget[] })[] {
  return incidents
    .filter((incident) => {
      const d = new Date(incident.start)
      const incidentMonth = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0')
      return incidentMonth === monthStr
    })
    .map((e) => ({
      ...e,
      monitors: (e.monitors || [])
        .map((e) => monitors.find((mon) => mon.id === e))
        .filter((monitor): monitor is MonitorTarget => !!monitor),
    }))
    .sort((a, b) => (new Date(a.start) > new Date(b.start) ? -1 : 1))
}

function getPrevNextMonth(monthStr: string) {
  const [year, month] = monthStr.split('-').map(Number)
  const date = new Date(year, month - 1)
  const prev = new Date(date)
  prev.setMonth(prev.getMonth() - 1)
  const next = new Date(date)
  next.setMonth(next.getMonth() + 1)
  return {
    prev: prev.getFullYear() + '-' + String(prev.getMonth() + 1).padStart(2, '0'),
    next: next.getFullYear() + '-' + String(next.getMonth() + 1).padStart(2, '0'),
  }
}

export default function IncidentsPage({
  monitors,
  probeFailures = [],
}: {
  monitors: MonitorTarget[]
  probeFailures?: ProbeFailureRow[]
}) {
  const { t } = useTranslation('common')
  const [selectedMonitor, setSelectedMonitor] = useState<string | null>('')
  const [selectedMonth, setSelectedMonth] = useState(getSelectedMonth())

  useEffect(() => {
    const onHashChange = () => setSelectedMonth(getSelectedMonth())
    window.addEventListener('hashchange', onHashChange)
    return () => window.removeEventListener('hashchange', onHashChange)
  }, [])

  const filteredIncidents = filterIncidentsByMonth(maintenances, selectedMonth, monitors)
  const monitorFilteredIncidents = selectedMonitor
    ? filteredIncidents.filter((i) => i.monitors.find((e) => e.id === selectedMonitor))
    : filteredIncidents
  const visibleProbeFailures = probeFailures.filter((failure) => {
    const date = new Date(failure.time * 1000)
    const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
    return month === selectedMonth && (!selectedMonitor || failure.monitorId === selectedMonitor)
  })

  const { prev, next } = getPrevNextMonth(selectedMonth)

  const monitorOptions = [
    { value: '', label: t('All') },
    ...monitors.map((monitor) => ({
      value: monitor.id,
      label: monitor.name,
    })),
  ]

  return (
    <>
      <Head>
        <title>{pageConfig.title}</title>
        <link rel="icon" href={pageConfig.favicon ?? '/favicon.png'} />
      </Head>

      <main className={inter.className}>
        <Header
          style={{
            marginBottom: '40px',
          }}
        />
        <Center>
          <Container size="md" style={{ width: '100%' }}>
            <Group justify="end" mb="md">
              <Select
                placeholder={t('Select monitor')}
                data={monitorOptions}
                value={selectedMonitor}
                onChange={setSelectedMonitor}
                clearable
                style={{ maxWidth: 300, float: 'right' }}
              />
            </Group>
            <Box>
              {monitors.some((monitor) => monitor.probes?.length) && (
                <Box mb="xl">
                  <Text fw={700} mb="xs">
                    {t('Probe failed checks heading')}
                  </Text>
                  <Text size="sm" c="dimmed" mb="sm">
                    {t('Probe incidents limit')}
                  </Text>
                  {visibleProbeFailures.length ? (
                    <div style={{ overflow: 'auto', maxHeight: 500 }}>
                      <Table striped highlightOnHover style={{ minWidth: 760 }}>
                        <Table.Thead>
                          <Table.Tr>
                            <Table.Th>{t('Probe time')}</Table.Th>
                            <Table.Th>{t('Probe monitor')}</Table.Th>
                            <Table.Th>{t('Probe name')}</Table.Th>
                            <Table.Th>{t('Probe stage')}</Table.Th>
                            <Table.Th>{t('Probe error code')}</Table.Th>
                            <Table.Th>{t('Probe error detail')}</Table.Th>
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {visibleProbeFailures.map((failure, index) => (
                            <Table.Tr key={`${failure.time}-${index}`}>
                              <Table.Td style={{ whiteSpace: 'nowrap' }}>
                                {new Date(failure.time * 1000).toLocaleString()}
                              </Table.Td>
                              <Table.Td>
                                <a href={`/#${failure.monitorId}`}>{failure.monitorName}</a>
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
                    <Text size="sm" c="dimmed">
                      {t('Probe no failed checks in month')}
                    </Text>
                  )}
                </Box>
              )}
              {monitors.some((monitor) => monitor.probes?.length) && (
                <Text fw={700} mb="xs">
                  {t('Probe published incidents')}
                </Text>
              )}
              {monitorFilteredIncidents.length === 0 ? (
                <NoIncidentsAlert />
              ) : (
                monitorFilteredIncidents.map((incident, i) => (
                  <MaintenanceAlert key={i} maintenance={incident} />
                ))
              )}
            </Box>
            <Group justify="space-between" mt="md">
              <Button variant="default" onClick={() => (window.location.hash = prev)}>
                {t('Backwards')}
              </Button>
              <Box style={{ alignSelf: 'center', fontWeight: 500, fontSize: 18 }}>
                {selectedMonth}
              </Box>
              <Button variant="default" onClick={() => (window.location.hash = next)}>
                {t('Forward')}
              </Button>
            </Group>
          </Container>
        </Center>
        <Footer />
      </main>
    </>
  )
}

export async function getServerSideProps() {
  const { workerConfig: fallbackConfig } = await import('@/uptime.config')
  const { getRuntimeConfig } = await import('@/worker/src/settings')
  const workerConfig = await getRuntimeConfig(process.env as any, fallbackConfig)
  // Only present these values to client
  const monitors: MonitorTarget[] = workerConfig.monitors.map((monitor) => ({
    id: monitor.id,
    name: monitor.name,
    ...(monitor.probes?.length && { probes: monitor.probes }),
  })) as MonitorTarget[]
  const summaries = await getProbeSummaries(
    process.env as any,
    workerConfig.monitors,
    workerConfig.probes,
    Math.round(Date.now() / 1000),
    workerConfig.probeStaleAfterSeconds
  )
  const probeFailures = Object.values(summaries)
    .flatMap((summary) =>
      summary.probes.flatMap((probe) =>
        probe.recentFailures.map((failure) => ({
          ...failure,
          monitorId: summary.monitorId,
          monitorName:
            monitors.find((monitor) => monitor.id === summary.monitorId)?.name ?? '未命名目标',
          probeName: probe.name,
        }))
      )
    )
    .sort((a, b) => b.time - a.time)
    .slice(0, 200)
  return { props: { monitors, probeFailures } }
}
