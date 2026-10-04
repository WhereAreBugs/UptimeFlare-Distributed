import { MaintenanceConfig, MonitorState, MonitorTarget, PageConfig } from '@/types/config'
import { Accordion, Card, Center, Text } from '@mantine/core'
import MonitorDetail from './MonitorDetail'
import { pageConfig as fallbackPageConfig } from '@/uptime.config'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProbeMonitorSummary } from '@/types/probes'
import { aggregateStatus, statusColors, summarizeMonitors } from '@/util/probe-status'

export default function MonitorList({
  monitors,
  state,
  probeSummaries = {},
  now = Math.round(Date.now() / 1000),
  page = fallbackPageConfig,
  maintenances,
}: {
  monitors: MonitorTarget[]
  state: MonitorState
  probeSummaries?: Record<string, ProbeMonitorSummary>
  now?: number
  page?: PageConfig
  maintenances?: MaintenanceConfig[]
}) {
  const { t } = useTranslation('common')
  const group = { ...page.group }
  if (Object.keys(group).length) {
    const ungrouped = monitors.filter(
      (monitor) => !Object.values(group).some((ids) => ids.includes(monitor.id))
    )
    if (ungrouped.length) {
      let name = t('Probe other monitors')
      let suffix = 2
      while (Object.hasOwn(group, name)) name = `${t('Probe other monitors')} (${suffix++})`
      group[name] = ungrouped.map((monitor) => monitor.id)
    }
  }
  const groupedMonitor = group && Object.keys(group).length > 0
  let content

  // Load expanded groups from localStorage
  const [expandedGroups, setExpandedGroups] = useState<string[]>(Object.keys(group))
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
      /* Private browsing or invalid saved preferences must not break the status page. */
    }
    setStorageLoaded(true)
  }, [])
  useEffect(() => {
    if (!storageLoaded) return
    try {
      window.localStorage.setItem('expandedGroups', JSON.stringify(expandedGroups))
    } catch {
      /* Storage is optional. */
    }
  }, [expandedGroups, storageLoaded])

  if (groupedMonitor) {
    // Grouped monitors
    content = (
      <Accordion
        multiple
        defaultValue={Object.keys(group)}
        variant="contained"
        value={expandedGroups}
        onChange={(values) => setExpandedGroups(values)}
      >
        {Object.keys(group).map((groupName) => {
          const members = monitors.filter((monitor) => group[groupName].includes(monitor.id))
          const counts = summarizeMonitors(members, state, probeSummaries, now)
          return (
            <Accordion.Item key={groupName} value={groupName}>
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
                  <div style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{groupName}</div>
                  <Text
                    fw={500}
                    style={{
                      display: 'inline',
                      paddingRight: '5px',
                      color:
                        statusColors[
                          aggregateStatus(counts.up, counts.down, counts.unknown, counts.degraded)
                        ],
                    }}
                  >
                    {t('Probe group counts', counts)}
                  </Text>
                </div>
              </Accordion.Control>
              <Accordion.Panel>
                {monitors
                  .filter((monitor) => group[groupName].includes(monitor.id))
                  .sort((a, b) => group[groupName].indexOf(a.id) - group[groupName].indexOf(b.id))
                  .map((monitor) => (
                    <div key={monitor.id}>
                      <Card.Section ml="xs" mr="xs">
                        <MonitorDetail
                          monitor={monitor}
                          state={state}
                          probeSummaries={probeSummaries}
                          now={now}
                          maintenances={maintenances}
                        />
                      </Card.Section>
                    </div>
                  ))}
              </Accordion.Panel>
            </Accordion.Item>
          )
        })}
      </Accordion>
    )
  } else {
    // Ungrouped monitors
    content = monitors.map((monitor) => (
      <div key={monitor.id}>
        <Card.Section ml="xs" mr="xs">
          <MonitorDetail
            monitor={monitor}
            state={state}
            probeSummaries={probeSummaries}
            now={now}
            maintenances={maintenances}
          />
        </Card.Section>
      </div>
    ))
  }

  return (
    <Center>
      <Card
        shadow="sm"
        padding="lg"
        radius="md"
        ml="md"
        mr="md"
        mt="xl"
        withBorder={!groupedMonitor}
        style={{ width: '100%', maxWidth: groupedMonitor ? 897 : 865, minWidth: 0 }}
      >
        {content}
      </Card>
    </Center>
  )
}
