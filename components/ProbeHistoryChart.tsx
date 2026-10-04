import { SegmentedControl, Stack, Text } from '@mantine/core'
import { memo, useState } from 'react'
import { Line } from 'react-chartjs-2'
import {
  Chart as ChartJS,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
  TimeScale,
} from 'chart.js'
import 'chartjs-adapter-moment'
import { useTranslation } from 'react-i18next'
import type { ProbeSummary } from '@/types/probes'
import { summarizeProbeDailyHistory, summarizeProbeHistory } from '@/util/probe-status'

ChartJS.register(LinearScale, PointElement, LineElement, Tooltip, Legend, TimeScale)

/** Deliberately mounted only inside an expanded monitor/probe panel. */
export default memo(function ProbeHistoryChart({
  probes,
  now,
  hideLatency,
}: {
  probes: ProbeSummary[]
  now: number
  hideLatency?: boolean
}) {
  const { t } = useTranslation('common')
  const [range, setRange] = useState(hideLatency ? '90d' : '12h')
  const days = summarizeProbeDailyHistory(probes, now)
  const latency = summarizeProbeHistory(probes, now)
  const uptime = hideLatency || range === '90d'
  const points = uptime
    ? days.map((day) => ({
        x: day.time * 1000,
        y: day.uptimePercent,
        checks: day.checks,
        failures: day.failures,
      }))
    : latency.map((bucket) => ({
        x: bucket.time * 1000,
        y: bucket.avgLatencyMs,
        checks: bucket.checks,
        failures: bucket.failures,
      }))
  const title = t(uptime ? 'Probe ninety day uptime' : 'Response times')
  return (
    <Stack gap="xs">
      {!hideLatency && (
        <SegmentedControl
          size="xs"
          value={range}
          onChange={setRange}
          data={[
            { value: '12h', label: t('Probe twelve hour latency') },
            { value: '90d', label: t('Probe ninety day uptime') },
          ]}
        />
      )}
      <div style={{ height: 180 }} role="img" aria-label={title}>
        <Line
          data={{
            datasets: [
              {
                label: title,
                data: points,
                borderColor: 'rgb(112, 119, 140)',
                borderWidth: 2,
                pointRadius: 0,
                pointHitRadius: 8,
                spanGaps: false,
                tension: 0,
              },
            ],
          }}
          options={{
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: { mode: 'nearest', intersect: false, axis: 'x' },
            plugins: {
              legend: { display: false },
              tooltip: {
                callbacks: {
                  label: (item) => {
                    const raw = item.raw as { y: number | null; checks: number; failures: number }
                    return raw.y === null
                      ? t('No Data')
                      : `${raw.y.toFixed(uptime ? 3 : 1)}${uptime ? '%' : ' ms'} · ${t(
                          'Probe retained stats',
                          { checks: raw.checks, failures: raw.failures }
                        )}`
                  },
                },
              },
            },
            scales: {
              x: { type: 'time', ticks: { maxRotation: 0, autoSkip: true } },
              y: {
                min: 0,
                ...(uptime && { max: 100 }),
                title: { display: true, text: uptime ? '%' : 'ms' },
              },
            },
          }}
        />
      </div>
      <Text size="xs" c="dimmed">
        {t(uptime ? 'Probe uptime observation explanation' : 'Probe latency gaps explanation')}
      </Text>
    </Stack>
  )
})
