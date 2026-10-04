import { Accordion, Badge, Group, Text, Tooltip } from '@mantine/core'
import dynamic from 'next/dynamic'
import { useMemo, useState } from 'react'
import { MaintenanceConfig, MonitorState, MonitorTarget } from '@/types/config'
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconCircleCheck,
  IconHelpCircle,
  IconPlayerPause,
} from '@tabler/icons-react'
const DetailChart = dynamic(() => import('./DetailChart'), { ssr: false })
const DetailBar = dynamic(() => import('./DetailBar'), { ssr: false })
import { getColor } from '@/util/color'
import { maintenances as fallbackMaintenances } from '@/uptime.config'
import { useTranslation } from 'react-i18next'
import type { ProbeMonitorSummary } from '@/types/probes'
import ProbeMonitorDetail from './ProbeMonitorDetail'
import { getMonitorStatus, statusColors } from '@/util/probe-status'
import { categoryColors, categoryLabels, getMonitorCategory } from '@/util/dashboard-status'
import { CompactedMonitorStateWrapper } from '@/worker/src/store'
import usePublicHistory from './usePublicHistory'

export default function MonitorDetail({
  monitor,
  state,
  probeSummaries = {},
  now = Math.round(Date.now() / 1000),
  maintenances = fallbackMaintenances,
  nativeHistoryLoaded = true,
  snapshotUnavailable = false,
}: {
  monitor: MonitorTarget
  state: MonitorState
  probeSummaries?: Record<string, ProbeMonitorSummary>
  now?: number
  maintenances?: MaintenanceConfig[]
  nativeHistoryLoaded?: boolean
  snapshotUnavailable?: boolean
}) {
  const { t } = useTranslation('common')
  const [expanded, setExpanded] = useState<string | null>(null)
  const native = !monitor.probes?.length
  const lazy = usePublicHistory(
    monitor.id,
    `${state.latency[monitor.id]?.slice(-1)[0]?.time ?? 'none'}:${Math.floor(now / 300)}`,
    native && !nativeHistoryLoaded,
    expanded === monitor.id,
    false
  )
  const nativeState = useMemo(
    () =>
      lazy.history?.historyLoaded
        ? new CompactedMonitorStateWrapper(lazy.history.compactedStateStr ?? null).uncompact()
        : state,
    [lazy.history, state]
  )
  const historyReady = nativeHistoryLoaded || !!lazy.history?.historyLoaded

  if (monitor.probes?.length)
    return (
      <ProbeMonitorDetail
        monitor={monitor}
        summary={probeSummaries[monitor.id]}
        now={now}
        maintenances={maintenances}
        snapshotUnavailable={snapshotUnavailable}
      />
    )

  const incidents = nativeState.incident[monitor.id]
  const status = getMonitorStatus(monitor, state, probeSummaries, now)
  const category = getMonitorCategory(monitor, status, maintenances, now)
  if (!nativeState.latency[monitor.id]?.length || !incidents?.length)
    return (
      <>
        <Group mt="sm" justify="space-between">
          <Text fw={700}>{monitor.name}</Text>
          <Badge color={categoryColors[category]} variant="light">
            {t(categoryLabels[category])}
          </Badge>
        </Group>
        <Text mt="sm" fw={700}>
          {t(monitor.paused ? 'Monitor paused history' : 'No data available')}
        </Text>
      </>
    )

  let statusIcon = monitor.paused ? (
    <IconPlayerPause size={20} color={categoryColors.closed} style={{ marginRight: 3 }} />
  ) : status === 'unknown' ? (
    <IconHelpCircle
      style={{
        width: '1.25em',
        height: '1.25em',
        color: statusColors.unknown,
        marginRight: '3px',
      }}
    />
  ) : status === 'down' ? (
    <IconAlertCircle
      style={{ width: '1.25em', height: '1.25em', color: '#b91c1c', marginRight: '3px' }}
    />
  ) : (
    <IconCircleCheck
      style={{ width: '1.25em', height: '1.25em', color: '#059669', marginRight: '3px' }}
    />
  )

  // Hide real status icon if monitor is in maintenance
  const currentDate = new Date(now * 1000)
  const hasMaintenance = maintenances
    .filter((m) => currentDate >= new Date(m.start) && (!m.end || currentDate <= new Date(m.end)))
    .find(
      (maintenance) => !maintenance.monitors?.length || maintenance.monitors.includes(monitor.id)
    )
  if (hasMaintenance && !monitor.paused)
    statusIcon = (
      <IconAlertTriangle
        style={{
          width: '1.25em',
          height: '1.25em',
          color: '#fab005',
          marginRight: '3px',
        }}
      />
    )

  let totalTime = now - incidents[0].start[0]
  let downTime = 0
  for (let incident of incidents) {
    downTime += (incident.end ?? now) - incident.start[0]
  }

  const uptimePercent = (
    totalTime > 0 ? ((totalTime - downTime) / totalTime) * 100 : 100
  ).toPrecision(4)

  // Conditionally render monitor name with or without hyperlink based on monitor.url presence
  const monitorNameElement = (
    <Text mt="sm" fw={700} style={{ display: 'inline-flex', alignItems: 'center' }}>
      {statusIcon} {monitor.name}
    </Text>
  )

  return (
    <Accordion
      value={expanded}
      onChange={setExpanded}
      variant="default"
      mt="sm"
      transitionDuration={0}
    >
      <Accordion.Item value={monitor.id}>
        <Accordion.Control>
          <div
            style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}
          >
            {monitor.tooltip ? (
              <Tooltip label={monitor.tooltip}>{monitorNameElement}</Tooltip>
            ) : (
              monitorNameElement
            )}

            <Group gap="xs" mt="sm">
              <Badge color={categoryColors[category]} variant="light">
                {t(categoryLabels[category])}
              </Badge>
              {historyReady && !snapshotUnavailable && (
                <Text fw={700} style={{ display: 'inline', color: getColor(uptimePercent, true) }}>
                  {t('Overall', { percent: uptimePercent })}
                </Text>
              )}
            </Group>
          </div>
        </Accordion.Control>
        <Accordion.Panel>
          {expanded === monitor.id && (
            <>
              {monitor.statusPageLink && (
                <Text size="sm" mb="sm">
                  <a href={monitor.statusPageLink} target="_blank" rel="noreferrer">
                    {t('Probe open status page')}
                  </a>
                </Text>
              )}
              {monitor.paused && (
                <Text size="xs" c="dimmed" mt={6}>
                  {t('Monitor paused history')}
                </Text>
              )}
              {historyReady ? (
                <>
                  <DetailBar monitor={monitor} state={nativeState} />
                  {!monitor.hideLatencyChart && (
                    <DetailChart monitor={monitor} state={nativeState} />
                  )}
                </>
              ) : (
                <Text size="sm" c="dimmed">
                  {t(lazy.failed ? 'Probe history unavailable' : 'Probe history loading')}
                </Text>
              )}
            </>
          )}
        </Accordion.Panel>
      </Accordion.Item>
    </Accordion>
  )
}
