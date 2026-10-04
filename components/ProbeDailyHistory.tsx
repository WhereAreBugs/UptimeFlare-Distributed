import { Group, Text } from '@mantine/core'
import { memo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProbeDailyBucket } from '@/types/probes'
import { statusColors, type MonitorStatus } from '@/util/probe-status'
import type { HistorySegment } from '@/util/history-segments'
import HistoryTimeline from './HistoryTimeline'
import HistorySelectionSummary from './HistorySelectionSummary'

const statusLabels: Record<MonitorStatus, string> = {
  up: 'Probe operational',
  degraded: 'Probe partial reachability',
  down: 'Probe unreachable',
  unknown: 'Probe unknown',
}

export default memo(function ProbeDailyHistory({
  days,
  monitorId,
}: {
  days: ProbeDailyBucket[]
  monitorId: string
}) {
  const { t } = useTranslation('common')
  const [selected, setSelected] = useState<HistorySegment<MonitorStatus> | null>(null)
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
  const range = (segment: HistorySegment<MonitorStatus>) =>
    `${date(segment.startTime)}${
      segment.bucketCount > 1 ? ` – ${date(segment.endTime - 1)}` : ''
    } UTC`
  const label = (segment: HistorySegment<MonitorStatus>) => {
    const uptime = segment.checks
      ? `${((100 * (segment.checks - segment.failures)) / segment.checks).toFixed(3)}%`
      : t('No Data')
    return `${range(segment)} · ${uptime} · ${t('Probe retained stats', segment)}`
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
        compactLabel={(segment) =>
          `${range(segment)} · ${t(statusLabels[segment.status])} · ${
            segment.avgLatencyMs === null ? '—' : `${segment.avgLatencyMs.toFixed(1)} ms`
          }`
        }
        href={(segment) => incidentHref(segment.startTime)}
        onSelect={setSelected}
      />
      <Group justify="space-between" mt={4}>
        <Text size="xs" c="dimmed">
          {t('Probe ninety days ago')}
        </Text>
        <Text size="xs" c="dimmed">
          {t('Probe today UTC')}
        </Text>
      </Group>
      {selected && (
        <HistorySelectionSummary
          range={range(selected)}
          reachability={t(statusLabels[selected.status])}
          averageLatencyMs={selected.avgLatencyMs}
        />
      )}
    </div>
  )
})
