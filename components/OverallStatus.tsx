import { MaintenanceConfig, MonitorTarget, PageConfig } from '@/types/config'
import { Center, Container, Title, Collapse, Group, Badge } from '@mantine/core'
import {
  IconCircleCheck,
  IconAlertCircle,
  IconAlertTriangle,
  IconHelpCircle,
} from '@tabler/icons-react'
import { useEffect, useState } from 'react'
import MaintenanceAlert from './MaintenanceAlert'
import { pageConfig as fallbackPageConfig } from '@/uptime.config'
import { useTranslation } from 'react-i18next'
import { aggregateStatus, statusColors, summarizeMonitors } from '@/util/probe-status'

function useWindowVisibility() {
  const [isVisible, setIsVisible] = useState(true)
  useEffect(() => {
    const handleVisibilityChange = () => setIsVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', handleVisibilityChange)
    return () => document.removeEventListener('visibilitychange', handleVisibilityChange)
  }, [])
  return isVisible
}

export default function OverallStatus({
  state,
  maintenances,
  monitors,
  aggregate,
  page = fallbackPageConfig,
}: {
  state: { overallUp: number; overallDown: number; lastUpdate: number }
  maintenances: MaintenanceConfig[]
  monitors: MonitorTarget[]
  aggregate?: ReturnType<typeof summarizeMonitors>
  page?: PageConfig
}) {
  const { t } = useTranslation('common')
  let group = page.group
  let groupedMonitor = (group && Object.keys(group).length > 0) || false

  let statusString = ''
  let icon = <IconAlertCircle style={{ width: 64, height: 64, color: '#b91c1c' }} />
  const counts = aggregate ?? {
    up: state.overallUp,
    down: state.overallDown,
    degraded: 0,
    unknown: 0,
    total: state.overallUp + state.overallDown,
    lastUpdate: state.lastUpdate,
  }
  const status = aggregateStatus(counts.up, counts.down, counts.unknown, counts.degraded)
  if (status === 'unknown') {
    statusString = t('No data yet')
    icon = <IconHelpCircle style={{ width: 64, height: 64, color: statusColors.unknown }} />
  } else if (status === 'down') {
    statusString = t(
      counts.unknown ? 'All reporting systems not operational' : 'All systems not operational'
    )
  } else if (status === 'up') {
    statusString = t(
      counts.unknown ? 'All reporting systems operational' : 'All systems operational'
    )
    icon = <IconCircleCheck style={{ width: 64, height: 64, color: '#059669' }} />
  } else {
    statusString =
      counts.degraded || counts.unknown
        ? t('Probe overall mixed')
        : t('Some systems not operational', { down: counts.down, total: counts.total })
    icon = <IconAlertTriangle style={{ width: 64, height: 64, color: statusColors.degraded }} />
  }

  const [openTime] = useState(Math.round(Date.now() / 1000))
  const [currentTime, setCurrentTime] = useState(Math.round(Date.now() / 1000))
  const isWindowVisible = useWindowVisibility()
  const [expandUpcoming, setExpandUpcoming] = useState(false)

  useEffect(() => {
    const interval = setInterval(() => {
      if (!isWindowVisible) return
      const now = Math.round(Date.now() / 1000)
      if (now - openTime >= 300) {
        window.location.reload()
      }
      setCurrentTime(now)
    }, 1000)
    return () => clearInterval(interval)
  }, [isWindowVisible, openTime])

  const now = new Date()

  const activeMaintenances: (Omit<MaintenanceConfig, 'monitors'> & {
    monitors?: MonitorTarget[]
  })[] = maintenances
    .filter((m) => now >= new Date(m.start) && (!m.end || now <= new Date(m.end)))
    .map((maintenance) => ({
      ...maintenance,
      monitors: maintenance.monitors?.map(
        (monitorId) => monitors.find((mon) => monitorId === mon.id)!
      ),
    }))

  const upcomingMaintenances: (Omit<MaintenanceConfig, 'monitors'> & {
    monitors?: (MonitorTarget | undefined)[]
  })[] = maintenances
    .filter((m) => now < new Date(m.start))
    .map((maintenance) => ({
      ...maintenance,
      monitors: maintenance.monitors?.map(
        (monitorId) => monitors.find((mon) => monitorId === mon.id)!
      ),
    }))

  return (
    <Container size="md" mt="xl">
      <Center>{icon}</Center>
      <Title mt="sm" style={{ textAlign: 'center' }} order={1}>
        {statusString}
      </Title>
      <Title mt="sm" style={{ textAlign: 'center', color: '#70778c' }} order={5}>
        {counts.lastUpdate
          ? t('Last updated on', {
              date: new Date(counts.lastUpdate * 1000).toLocaleString(),
              seconds: Math.max(0, currentTime - counts.lastUpdate),
            })
          : t('Probe never reported')}
      </Title>
      {!!aggregate && (
        <Group justify="center" gap="xs" mt="sm">
          <Badge color={statusColors.up} variant="light">
            {t('Probe operational')}: {counts.up}
          </Badge>
          <Badge color={statusColors.degraded} variant="light">
            {t('Probe partial reachability')}: {counts.degraded}
          </Badge>
          <Badge color={statusColors.down} variant="light">
            {t('Probe unreachable')}: {counts.down}
          </Badge>
          <Badge color={statusColors.unknown} variant="light">
            {t('Probe unknown')}: {counts.unknown}
          </Badge>
        </Group>
      )}

      {/* Upcoming Maintenance */}
      {upcomingMaintenances.length > 0 && (
        <>
          <Title mt="4px" style={{ textAlign: 'center', color: '#70778c' }} order={5}>
            {t('upcoming maintenance', { count: upcomingMaintenances.length })}{' '}
            <span
              style={{ textDecoration: 'underline', cursor: 'pointer' }}
              onClick={() => setExpandUpcoming(!expandUpcoming)}
            >
              {expandUpcoming ? t('Hide') : t('Show')}
            </span>
          </Title>

          <Collapse in={expandUpcoming}>
            {upcomingMaintenances.map((maintenance, idx) => (
              <MaintenanceAlert
                key={`upcoming-${idx}`}
                maintenance={maintenance}
                page={page}
                style={{ maxWidth: groupedMonitor ? '897px' : '865px' }}
                upcoming
              />
            ))}
          </Collapse>
        </>
      )}

      {/* Active Maintenance */}
      {activeMaintenances.map((maintenance, idx) => (
        <MaintenanceAlert
          key={`active-${idx}`}
          maintenance={maintenance}
          page={page}
          style={{ maxWidth: groupedMonitor ? '897px' : '865px' }}
        />
      ))}
    </Container>
  )
}
