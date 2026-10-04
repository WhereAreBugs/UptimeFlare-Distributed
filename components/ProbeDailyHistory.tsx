import { Group, Text, Tooltip } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import type { ProbeDailyBucket } from '@/types/probes'
import { statusColors } from '@/util/probe-status'

export default function ProbeDailyHistory({
  days,
  monitorId,
}: {
  days: ProbeDailyBucket[]
  monitorId: string
}) {
  const { t } = useTranslation('common')
  return (
    <div>
      <div
        style={{ display: 'flex', gap: 2, height: 20 }}
        role="group"
        aria-label={t('Probe ninety day uptime')}
      >
        {days.map((day) => {
          const status = !day.checks
            ? 'unknown'
            : !day.failures
            ? 'up'
            : day.failures === day.checks
            ? 'down'
            : 'degraded'
          const date = new Date(day.time * 1000).toISOString().slice(0, 10)
          const label = `${date} UTC · ${
            day.uptimePercent === null ? t('No Data') : `${day.uptimePercent.toFixed(3)}%`
          } · ${t('Probe retained stats', { checks: day.checks, failures: day.failures })}`
          return (
            <Tooltip
              key={day.time}
              label={label}
              multiline
              events={{ hover: true, focus: true, touch: true }}
            >
              <a
                href={`/incidents?monitor=${encodeURIComponent(monitorId)}#${date.slice(0, 7)}`}
                aria-label={label}
                style={{ flex: 1, minWidth: 1, background: statusColors[status], borderRadius: 2 }}
              />
            </Tooltip>
          )
        })}
      </div>
      <Group justify="space-between" mt={4}>
        <Text size="xs" c="dimmed">
          {t('Probe ninety days ago')}
        </Text>
        <Text size="xs" c="dimmed">
          {t('Probe today UTC')}
        </Text>
      </Group>
    </div>
  )
}
