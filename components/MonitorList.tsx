import type { MaintenanceConfig, MonitorState, MonitorTarget, PageConfig } from '@/types/config'
import { Accordion, Card, Center, Pagination, Stack, Text } from '@mantine/core'
import MonitorDetail from './MonitorDetail'
import {
  pageConfig as fallbackPageConfig,
  maintenances as fallbackMaintenances,
} from '@/uptime.config'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProbeMonitorSummary } from '@/types/probes'
import {
  categoryColors,
  categoryLabels,
  dashboardCategory,
  summarizeDashboardMonitors,
  type MonitorCategory,
} from '@/util/dashboard-status'
import {
  publicMonitorGroups,
  publicMonitorPage,
  visiblePublicMonitors,
} from '@/util/public-monitor-list'

export default function MonitorList({
  monitors,
  state,
  probeSummaries = {},
  now = Math.round(Date.now() / 1000),
  page = fallbackPageConfig,
  maintenances = fallbackMaintenances,
  nativeHistoryLoaded = true,
}: {
  monitors: MonitorTarget[]
  state: MonitorState
  probeSummaries?: Record<string, ProbeMonitorSummary>
  now?: number
  page?: PageConfig
  maintenances?: MaintenanceConfig[]
  nativeHistoryLoaded?: boolean
}) {
  const { t } = useTranslation('common')
  const active = useMemo(
    () => visiblePublicMonitors(monitors, probeSummaries),
    [monitors, probeSummaries]
  )
  const groups = useMemo(
    () => publicMonitorGroups(active, page.group ?? {}, t('Probe other monitors')),
    [active, page.group, t]
  )
  const grouped = Object.keys(page.group ?? {}).length > 0
  const [expandedGroups, setExpandedGroups] = useState<string[]>([])
  const [pages, setPages] = useState<Record<string, number>>({})
  const [storageLoaded, setStorageLoaded] = useState(false)
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem('expandedGroups')
      if (saved) {
        const parsed: unknown = JSON.parse(saved)
        if (Array.isArray(parsed) && parsed.every((value) => typeof value === 'string'))
          setExpandedGroups(parsed)
      }
    } catch {
      /* Preferences are optional. */
    }
    setStorageLoaded(true)
  }, [])
  useEffect(() => {
    if (!storageLoaded) return
    try {
      window.localStorage.setItem('expandedGroups', JSON.stringify(expandedGroups))
    } catch {
      /* Preferences are optional. */
    }
  }, [expandedGroups, storageLoaded])

  if (!active.length) return null
  const renderPage = (members: MonitorTarget[], key: string) => {
    const selected = publicMonitorPage(members, pages[key] ?? 1)
    return (
      <Stack gap="sm">
        {selected.items.map((monitor) => (
          <div key={monitor.id}>
            <MonitorDetail
              monitor={monitor}
              state={state}
              probeSummaries={probeSummaries}
              now={now}
              maintenances={maintenances}
              nativeHistoryLoaded={nativeHistoryLoaded}
            />
          </div>
        ))}
        {selected.pages > 1 && (
          <Pagination
            total={selected.pages}
            value={selected.page}
            size="sm"
            onChange={(value) => setPages((current) => ({ ...current, [key]: value }))}
            aria-label={`${key} · ${t('Probe page')}`}
          />
        )}
      </Stack>
    )
  }
  return (
    <Center>
      <Card
        shadow="sm"
        padding="lg"
        radius="md"
        ml="md"
        mr="md"
        mt="md"
        withBorder={!grouped}
        style={{ width: '100%', maxWidth: grouped ? 897 : 865, minWidth: 0 }}
      >
        {grouped ? (
          <Accordion
            multiple
            variant="contained"
            value={expandedGroups}
            onChange={setExpandedGroups}
            transitionDuration={0}
          >
            {groups.map((group) => {
              const counts = summarizeDashboardMonitors(
                group.monitors,
                state,
                probeSummaries,
                maintenances,
                now
              )
              return (
                <Accordion.Item key={group.name} value={group.name}>
                  <Accordion.Control>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        width: '100%',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        gap: '4px 12px',
                      }}
                    >
                      <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{group.name}</div>
                      <Text
                        fw={500}
                        style={{
                          display: 'inline',
                          paddingRight: 5,
                          color: categoryColors[dashboardCategory(counts)],
                        }}
                      >
                        {(['healthy', 'closed', 'maintenance', 'abnormal'] as MonitorCategory[])
                          .map((category) => `${t(categoryLabels[category])} ${counts[category]}`)
                          .join(' · ')}
                      </Text>
                    </div>
                  </Accordion.Control>
                  <Accordion.Panel>
                    {expandedGroups.includes(group.name) && renderPage(group.monitors, group.name)}
                  </Accordion.Panel>
                </Accordion.Item>
              )
            })}
          </Accordion>
        ) : (
          renderPage(active, t('Monitor totals'))
        )}
      </Card>
    </Center>
  )
}
