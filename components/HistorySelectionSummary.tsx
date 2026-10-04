import { useMediaQuery } from '@mantine/hooks'
import { useTranslation } from 'react-i18next'
import classes from '@/styles/HistoryTimeline.module.css'

export function formatHistoryTimeRange(startTime: number, endTime: number): string {
  const start = new Date(startTime * 1000)
  const end = new Date(endTime * 1000)
  const options: Intl.DateTimeFormatOptions = {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }
  const endLabel =
    start.toDateString() === end.toDateString()
      ? end.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })
      : end.toLocaleString(undefined, options)
  return `${start.toLocaleString(undefined, options)} – ${endLabel}`
}

export default function HistorySelectionSummary({
  range,
  reachability,
  averageLatencyMs,
}: {
  range: string
  reachability: string
  averageLatencyMs: number | null
}) {
  const { t } = useTranslation('common')
  const compact = useMediaQuery('(max-width: 48em)', false, { getInitialValueInEffect: false })
  if (!compact) return null
  return (
    <dl className={classes.summary} role="status">
      <dt>{t('History selected range')}</dt>
      <dd>{range}</dd>
      <dt>{t('History reachability')}</dt>
      <dd>{reachability}</dd>
      <dt>{t('Probe average latency')}</dt>
      <dd>{averageLatencyMs === null ? '—' : `${averageLatencyMs.toFixed(1)} ms`}</dd>
    </dl>
  )
}
