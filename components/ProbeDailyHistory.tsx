import { Anchor, Group, Modal, Stack, Text } from '@mantine/core'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProbeDailyBucket } from '@/types/probes'
import { statusColors, type MonitorStatus } from '@/util/probe-status'
import type { HistorySegment } from '@/util/history-segments'
import HistoryTimeline from './HistoryTimeline'

export default function ProbeDailyHistory({
  days,
  monitorId,
}: {
  days: ProbeDailyBucket[]
  monitorId: string
}) {
  const { t } = useTranslation('common')
  const [selected, setSelected] = useState<{
    segment: HistorySegment<MonitorStatus>
    days: ProbeDailyBucket[]
  } | null>(null)
  const buckets: (ProbeDailyBucket & { status: MonitorStatus })[] = days.map((day) => ({
    ...day,
    status: !day.checks
      ? 'unknown'
      : !day.failures
      ? 'up'
      : day.failures === day.checks
      ? 'down'
      : 'degraded',
  }))
  const date = (time: number) => new Date(time * 1000).toISOString().slice(0, 10)
  const incidentHref = (time: number) =>
    `/incidents?monitor=${encodeURIComponent(monitorId)}#${date(time).slice(0, 7)}`
  const label = (segment: HistorySegment<MonitorStatus>) => {
    const range = `${date(segment.startTime)}${
      segment.bucketCount > 1 ? ` – ${date(segment.endTime - 1)}` : ''
    } UTC`
    const uptime = segment.checks
      ? `${((100 * (segment.checks - segment.failures)) / segment.checks).toFixed(3)}%`
      : t('No Data')
    return `${range} · ${uptime} · ${t('Probe retained stats', segment)}`
  }
  return (
    <div>
      <HistoryTimeline
        buckets={buckets}
        bucketSeconds={86400}
        ariaLabel={t('Probe ninety day uptime')}
        height={20}
        color={(status) => statusColors[status]}
        label={label}
        href={(segment) => incidentHref(segment.startTime)}
        onSelect={(segment) =>
          setSelected({ segment, days: days.slice(segment.firstIndex, segment.lastIndex + 1) })
        }
      />
      <Group justify="space-between" mt={4}>
        <Text size="xs" c="dimmed">
          {t('Probe ninety days ago')}
        </Text>
        <Text size="xs" c="dimmed">
          {t('Probe today UTC')}
        </Text>
      </Group>
      <Modal
        opened={selected !== null}
        onClose={() => setSelected(null)}
        title={t('Probe ninety day uptime')}
      >
        {selected && (
          <Stack gap="sm">
            <Text size="sm">{label(selected.segment)}</Text>
            <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
              {selected.days.map((day) => (
                <div key={day.time} style={{ marginBottom: 12 }}>
                  <Anchor href={incidentHref(day.time)} size="sm">
                    {date(day.time)} UTC
                  </Anchor>
                  <Text size="xs" c="dimmed">
                    {day.uptimePercent === null ? t('No Data') : `${day.uptimePercent.toFixed(3)}%`}
                    {' · '}
                    {t('Probe retained stats', day)}
                  </Text>
                </div>
              ))}
            </div>
          </Stack>
        )}
      </Modal>
    </div>
  )
}
