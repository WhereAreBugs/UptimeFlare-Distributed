import { Text, Tooltip } from '@mantine/core'
import { MonitorState, MonitorTarget } from '@/types/config'
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconCircleCheck,
  IconHelpCircle,
} from '@tabler/icons-react'
import DetailChart from './DetailChart'
import DetailBar from './DetailBar'
import { getColor } from '@/util/color'
import { maintenances } from '@/uptime.config'
import { useTranslation } from 'react-i18next'
import type { ProbeMonitorSummary } from '@/types/probes'
import ProbeMonitorDetail from './ProbeMonitorDetail'
import { getMonitorStatus, statusColors } from '@/util/probe-status'

export default function MonitorDetail({
  monitor,
  state,
  probeSummaries = {},
  now = Math.round(Date.now() / 1000),
}: {
  monitor: MonitorTarget
  state: MonitorState
  probeSummaries?: Record<string, ProbeMonitorSummary>
  now?: number
}) {
  const { t } = useTranslation('common')

  if (monitor.probes?.length)
    return <ProbeMonitorDetail monitor={monitor} summary={probeSummaries[monitor.id]} now={now} />

  const incidents = state.incident[monitor.id]
  if (!state.latency[monitor.id]?.length || !incidents?.length)
    return (
      <>
        <Text mt="sm" fw={700}>
          {monitor.name}
        </Text>
        <Text mt="sm" fw={700}>
          {t('No data available')}
        </Text>
      </>
    )

  const status = getMonitorStatus(monitor, state, probeSummaries, now)
  let statusIcon =
    status === 'unknown' ? (
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
    .find((maintenance) => maintenance.monitors?.includes(monitor.id))
  if (hasMaintenance)
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
      {monitor.statusPageLink ? (
        <a
          href={monitor.statusPageLink}
          target="_blank"
          rel="noreferrer"
          style={{ display: 'inline-flex', alignItems: 'center', color: 'inherit' }}
        >
          {statusIcon} {monitor.name}
        </a>
      ) : (
        <>
          {statusIcon} {monitor.name}
        </>
      )}
    </Text>
  )

  return (
    <>
      <div style={{ display: 'flex', justifyContent: 'space-between' }}>
        {monitor.tooltip ? (
          <Tooltip label={monitor.tooltip}>{monitorNameElement}</Tooltip>
        ) : (
          monitorNameElement
        )}

        <Text mt="sm" fw={700} style={{ display: 'inline', color: getColor(uptimePercent, true) }}>
          {t('Overall', { percent: uptimePercent })}
        </Text>
      </div>

      <DetailBar monitor={monitor} state={state} />
      {!monitor.hideLatencyChart && <DetailChart monitor={monitor} state={state} />}
    </>
  )
}
