import type { MaintenanceConfig, MonitorTarget, PageConfig } from '@/types/config'
import { Container, Text } from '@mantine/core'
import MaintenanceAlert from './MaintenanceAlert'
import { pageConfig as fallbackPageConfig } from '@/uptime.config'
import { useTranslation } from 'react-i18next'
import {
  categoryColors,
  categoryLabels,
  dashboardCategory,
  type DashboardCounts,
  type MonitorCategory,
} from '@/util/dashboard-status'
import classes from '@/styles/OverallStatus.module.css'

export default function OverallStatus({
  maintenances,
  monitors,
  aggregate,
  now,
  page = fallbackPageConfig,
}: {
  maintenances: MaintenanceConfig[]
  monitors: MonitorTarget[]
  aggregate: DashboardCounts
  now: number
  page?: PageConfig
}) {
  const { t } = useTranslation('common')
  const category = dashboardCategory(aggregate)
  const color = categoryColors[category]
  const plans = maintenances.map((plan) => ({
    ...plan,
    monitors: plan.monitors?.map((id) => monitors.find((monitor) => monitor.id === id)),
  }))
  const active = plans.filter(
    (plan) =>
      new Date(plan.start).getTime() <= now * 1000 &&
      (!plan.end || new Date(plan.end).getTime() >= now * 1000)
  )
  const upcoming = plans.filter((plan) => new Date(plan.start).getTime() > now * 1000)
  return (
    <Container size="md" mt={12}>
      <div
        className={classes.status}
        style={{ color, borderColor: color, background: `${color}12` }}
        role="status"
      >
        <span className={classes.square} style={{ background: color }} aria-hidden />
        {aggregate.total ? t(categoryLabels[category]) : t('No data yet')}
      </div>
      <div className={classes.counts} aria-label={t('Monitor totals')}>
        {(['healthy', 'closed', 'maintenance', 'abnormal'] as MonitorCategory[]).map((value) => (
          <span key={value} className={classes.count}>
            {t(categoryLabels[value])} <strong>{aggregate[value]}</strong>
          </span>
        ))}
      </div>
      {!!aggregate.lastUpdate && (
        <Text size="xs" c="dimmed" mt={4}>
          {t('Last updated on', {
            date: new Date(aggregate.lastUpdate * 1000).toLocaleString(),
            seconds: Math.max(0, now - aggregate.lastUpdate),
          })}
        </Text>
      )}
      {[
        { plans: active, upcoming: false },
        { plans: upcoming, upcoming: true },
      ].map(
        (section) =>
          section.plans.length > 0 && (
            <details className={classes.announcements} key={String(section.upcoming)}>
              <summary>
                {section.upcoming
                  ? t('upcoming maintenance', { count: section.plans.length })
                  : `${t('Scheduled Maintenance')} (${section.plans.length})`}
              </summary>
              {section.plans.map((maintenance, index) => (
                <MaintenanceAlert
                  key={`${maintenance.id ?? index}-${maintenance.start}`}
                  maintenance={maintenance}
                  page={page}
                  upcoming={section.upcoming}
                />
              ))}
            </details>
          )
      )}
    </Container>
  )
}
