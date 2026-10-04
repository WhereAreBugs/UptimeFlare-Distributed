import { Accordion, Badge, Box, Group, Stack, Table, Text, Tooltip } from '@mantine/core'
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconCircleCheck,
  IconHelpCircle,
  IconPlayerPause,
} from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { memo, useMemo, useState } from 'react'
import dynamic from 'next/dynamic'
import type { MaintenanceConfig, MonitorTarget } from '@/types/config'
import type { ProbeMonitorSummary, ProbeSummary } from '@/types/probes'
import {
  refreshProbeSummary,
  statusColors,
  summarizeProbeHistory,
  summarizeProbeDailyHistory,
  type MonitorStatus,
} from '@/util/probe-status'
const ProbeHistoryChart = dynamic(() => import('./ProbeHistoryChart'), { ssr: false })
import ProbeDailyHistory from './ProbeDailyHistory'
import HistoryTimeline from './HistoryTimeline'
import HistorySelectionSummary, { formatHistoryTimeRange } from './HistorySelectionSummary'
import type { HistorySegment } from '@/util/history-segments'
import { categoryColors, getActiveMaintenance, getMonitorCategory } from '@/util/dashboard-status'
import { maintenances as fallbackMaintenances } from '@/util/public-defaults'
import usePublicHistory from './usePublicHistory'
import { withProbeHistory } from '@/util/public-history-loader'

const historyColors = { ...statusColors, degraded: '#eab308' }

const statusLabels: Record<MonitorStatus, string> = {
  up: 'Probe operational',
  degraded: 'Probe partial reachability',
  down: 'Probe unreachable',
  unknown: 'Probe unknown',
}

function StatusIcon({ status }: { status: MonitorStatus }) {
  const Icon = {
    up: IconCircleCheck,
    degraded: IconAlertTriangle,
    down: IconAlertCircle,
    unknown: IconHelpCircle,
  }[status]
  return <Icon size={20} color={statusColors[status]} aria-hidden />
}

function emptyProbe(id: string, index: number): ProbeSummary {
  return {
    id,
    name: id === 'cloudflare' ? 'Cloudflare' : `探针 ${index + 1}`,
    status: 'unknown',
    stale: false,
    latest: null,
    latencyMs: null,
    checks: 0,
    failures: 0,
    avgLatencyMs: null,
    failureStages: {},
    history: [],
    dailyHistory: [],
    uptimePercent: null,
    retainedFrom: null,
    recentFailures: [],
  }
}

const ProbeHistory = memo(function ProbeHistory({
  probes,
  name,
  now,
}: {
  probes: ProbeSummary[]
  name: string
  now: number
}) {
  const { t } = useTranslation('common')
  const bucketWindow = Math.floor(now / 300)
  const buckets = useMemo(
    () => summarizeProbeHistory(probes, bucketWindow * 300),
    [probes, bucketWindow]
  )
  const [selected, setSelected] = useState<HistorySegment<MonitorStatus> | null>(null)
  const label = (
    segment: HistorySegment<MonitorStatus>,
    members = buckets.slice(segment.firstIndex, segment.lastIndex + 1)
  ) => {
    const reported = members.map((bucket) => bucket.reported)
    const minimum = Math.min(...reported)
    const maximum = Math.max(...reported)
    const total = members[0].total
    const range = `${new Date(segment.startTime * 1000).toLocaleString()}${
      segment.bucketCount > 1 ? ` – ${new Date(segment.endTime * 1000).toLocaleString()}` : ''
    }`
    return `${range}: ${t(statusLabels[segment.status])} · ${
      segment.checks
        ? t('Probe bucket detail', {
            checks: segment.checks,
            failures: segment.failures,
            latency: segment.avgLatencyMs?.toFixed(1) ?? '—',
          })
        : t('Probe no samples')
    }${
      total > 1
        ? ` · ${t('Probe history coverage', {
            reported: minimum === maximum ? minimum : `${minimum}–${maximum}`,
            total,
          })}`
        : ''
    }`
  }
  return (
    <div>
      <HistoryTimeline
        buckets={buckets}
        bucketSeconds={300}
        ariaLabel={`${name} · ${t('Probe history')}`}
        height={24}
        color={(status) => historyColors[status]}
        label={label}
        compactLabel={(segment) =>
          `${formatHistoryTimeRange(segment.startTime, segment.endTime)} · ${t(
            statusLabels[segment.status]
          )} · ${segment.avgLatencyMs === null ? '—' : `${segment.avgLatencyMs.toFixed(1)} ms`}`
        }
        onSelect={setSelected}
      />
      <Group justify="space-between" mt={4}>
        <Text size="xs" c="dimmed">
          {t('Probe twelve hours ago')}
        </Text>
        <Text size="xs" c="dimmed">
          {t('Probe now')}
        </Text>
      </Group>
      {selected && (
        <HistorySelectionSummary
          range={formatHistoryTimeRange(selected.startTime, selected.endTime)}
          reachability={t(statusLabels[selected.status])}
          averageLatencyMs={selected.avgLatencyMs}
        />
      )}
    </div>
  )
})

function ProbeDetails({
  probe,
  now,
  hideLatency,
  monitorId,
  historical = false,
}: {
  probe: ProbeSummary
  now: number
  hideLatency?: boolean
  monitorId: string
  historical?: boolean
}) {
  const { t } = useTranslation('common')
  const [showFailures, setShowFailures] = useState(false)
  const stageLabel = (stage: string) => t(`Probe stage ${stage}`, { defaultValue: stage })
  return (
    <Stack gap="sm">
      {probe.stale && !historical && (
        <Text size="sm" c="dimmed">
          {t('Probe stale explanation')}
        </Text>
      )}
      <Group gap="lg">
        <Text size="sm">
          {t('Probe last check')}:{' '}
          {probe.latest === null
            ? t('Probe never reported')
            : new Date(probe.latest * 1000).toLocaleString()}
        </Text>
        {!hideLatency && (
          <Text size="sm">
            {t('Probe latest latency')}:{' '}
            {probe.latencyMs === null ? '—' : `${probe.latencyMs.toFixed(1)} ms`}
          </Text>
        )}
      </Group>
      {probe.certificateExpiresAt !== undefined && (
        <Text size="sm">
          {t('Probe certificate expiry')}:{' '}
          {new Date(probe.certificateExpiresAt * 1000).toLocaleString()}
          {' · '}
          {t('Probe certificate days', {
            days: ((probe.certificateExpiresAt - now) / 86400).toFixed(1),
          })}
        </Text>
      )}
      {probe.icmpLatencyMs !== undefined && (
        <Text size="sm">ICMP: {probe.icmpLatencyMs.toFixed(1)} ms</Text>
      )}
      {probe.stage && (
        <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
          {t('Probe last failure')}: {stageLabel(probe.stage)} · {probe.code}
          {probe.message && ` · ${probe.message}`}
        </Text>
      )}
      <Group gap="lg">
        <Text size="sm">
          {t('Probe retained stats', { checks: probe.checks, failures: probe.failures })}
        </Text>
        {!hideLatency && (
          <Text size="sm">
            {t('Probe average latency')}:{' '}
            {probe.avgLatencyMs === null ? '—' : `${probe.avgLatencyMs.toFixed(1)} ms`}
          </Text>
        )}
      </Group>
      <Text size="xs" c="dimmed">
        {t('Probe successful bucket average explanation')}
      </Text>
      <div>
        <Text size="sm" fw={500} mb={5}>
          {t('Probe failure statistics')}
        </Text>
        <Group gap="xs">
          {Object.entries(probe.failureStages).map(([stage, count]) => (
            <Badge key={stage} color="red" variant="light">
              {stageLabel(stage)}: {count}
            </Badge>
          ))}
          {!Object.keys(probe.failureStages).length && (
            <Text size="sm" c="dimmed">
              {t('Probe no failures')}
            </Text>
          )}
        </Group>
      </div>
      <ProbeHistory probes={[probe]} name={probe.name} now={now} />
      <ProbeDailyHistory days={summarizeProbeDailyHistory([probe], now)} monitorId={monitorId} />
      <ProbeHistoryChart probes={[probe]} now={now} hideLatency={hideLatency} />
      {!!probe.recentFailures.length && (
        <details onToggle={(event) => setShowFailures(event.currentTarget.open)}>
          <summary style={{ cursor: 'pointer', fontSize: 14 }}>
            {t('Probe recent failures', { count: probe.recentFailures.length })}
          </summary>
          <Text size="xs" c="dimmed" mt={6}>
            {t('Probe failure history limit')}
            {' · '}
            <a href={`/incidents?monitor=${encodeURIComponent(monitorId)}`}>
              {t('Probe full incident history')}
            </a>
          </Text>
          {showFailures && (
            <div style={{ overflow: 'auto', maxHeight: 340 }}>
              <Table striped highlightOnHover mt="xs" style={{ minWidth: 580 }}>
                <Table.Thead>
                  <Table.Tr>
                    <Table.Th>{t('Probe time')}</Table.Th>
                    <Table.Th>{t('Probe stage')}</Table.Th>
                    <Table.Th>{t('Probe error code')}</Table.Th>
                    <Table.Th>{t('Probe error detail')}</Table.Th>
                  </Table.Tr>
                </Table.Thead>
                <Table.Tbody>
                  {probe.recentFailures.map((failure, index) => (
                    <Table.Tr key={`${failure.time}-${index}`}>
                      <Table.Td style={{ whiteSpace: 'nowrap' }}>
                        {new Date(failure.time * 1000).toLocaleString()}
                      </Table.Td>
                      <Table.Td>{stageLabel(failure.stage)}</Table.Td>
                      <Table.Td>{failure.code}</Table.Td>
                      <Table.Td style={{ overflowWrap: 'anywhere' }}>{failure.message}</Table.Td>
                    </Table.Tr>
                  ))}
                </Table.Tbody>
              </Table>
            </div>
          )}
        </details>
      )}
    </Stack>
  )
}

export default function ProbeMonitorDetail({
  monitor,
  summary,
  now,
  maintenances = fallbackMaintenances,
  snapshotUnavailable = false,
}: {
  monitor: MonitorTarget
  summary?: ProbeMonitorSummary
  now: number
  maintenances?: MaintenanceConfig[]
  snapshotUnavailable?: boolean
}) {
  const { t } = useTranslation('common')
  const [expandedMonitor, setExpandedMonitor] = useState<string | null>(null)
  const [expandedProbes, setExpandedProbes] = useState<string[]>([])
  const lazy = usePublicHistory(
    monitor.id,
    `${summary?.latest ?? 'none'}:${monitor.probes?.join(',') ?? ''}:${Math.floor(now / 300)}`,
    summary?.historyLoaded === false && (!snapshotUnavailable || expandedMonitor === monitor.id),
    expandedMonitor === monitor.id
  )
  const historical = useMemo(
    () => withProbeHistory(summary, lazy.history?.summary),
    [summary, lazy.history]
  )
  const current = useMemo(
    () => (historical ? refreshProbeSummary(historical, now, monitor) : undefined),
    [historical, now, monitor]
  )
  const showHistory = (!snapshotUnavailable && lazy.inView) || expandedMonitor === monitor.id
  const historyReady = historical?.historyLoaded !== false
  const historyProbes = useMemo(
    () => historical?.probes ?? monitor.probes?.map(emptyProbe) ?? [],
    [historical, monitor.probes]
  )
  const day = Math.floor(now / 86400)
  const days = useMemo(
    () => (showHistory ? summarizeProbeDailyHistory(historyProbes, day * 86400) : []),
    [historyProbes, day, showHistory]
  )
  const paused = !!(monitor.paused || current?.paused || current?.status === 'paused')
  const status = current?.status === 'paused' ? 'unknown' : current?.status ?? 'unknown'
  const probes = current?.probes ?? monitor.probes?.map(emptyProbe) ?? []
  const maintenance = !paused && getActiveMaintenance(monitor, maintenances, now)
  const category = getMonitorCategory(monitor, paused ? 'paused' : status, maintenances, now)
  const totals = {
    up: current?.up ?? 0,
    total: (current?.up ?? 0) + (current?.down ?? 0),
  }
  return (
    <Box ref={lazy.ref}>
      <Accordion
        variant="default"
        mt="sm"
        value={expandedMonitor}
        onChange={setExpandedMonitor}
        transitionDuration={0}
      >
        <Accordion.Item value={monitor.id}>
          <Accordion.Control>
            <Group justify="space-between" gap="sm" wrap="wrap">
              <Group gap={6}>
                {paused ? (
                  <IconPlayerPause size={20} color={categoryColors.closed} aria-hidden />
                ) : maintenance ? (
                  <IconAlertTriangle size={20} color="#fab005" aria-hidden />
                ) : (
                  <StatusIcon status={status} />
                )}
                <Tooltip label={monitor.tooltip} disabled={!monitor.tooltip}>
                  <Text fw={700}>{monitor.name}</Text>
                </Tooltip>
              </Group>
              <Group gap="xs">
                <Badge
                  color={paused || maintenance ? categoryColors[category] : statusColors[status]}
                  variant="light"
                >
                  {t(paused ? 'Closed' : maintenance ? 'Maintenance' : statusLabels[status])}
                </Badge>
                {!paused && (
                  <Text size="sm" c="dimmed">
                    {t('Probe summary counts', totals)}
                  </Text>
                )}
                {!snapshotUnavailable && (
                  <Text size="sm" fw={600}>
                    {current?.uptimePercent === null || current?.uptimePercent === undefined
                      ? t('No Data')
                      : t('Overall', { percent: current.uptimePercent.toFixed(3) })}
                  </Text>
                )}
              </Group>
            </Group>
          </Accordion.Control>
          {showHistory && (
            <Box px="md" pb="sm">
              {paused && (
                <Text size="xs" c="dimmed" mb={6}>
                  {t('Monitor paused history')}
                </Text>
              )}
              {historyReady ? (
                <>
                  <ProbeHistory
                    probes={historyProbes}
                    name={monitor.name}
                    now={Math.floor(now / 300) * 300}
                  />
                  <Box mt="sm">
                    <ProbeDailyHistory days={days} monitorId={monitor.id} />
                  </Box>
                </>
              ) : (
                <Text size="xs" c="dimmed">
                  {t(lazy.failed ? 'Probe history unavailable' : 'Probe history loading')}
                </Text>
              )}
            </Box>
          )}
          <Accordion.Panel>
            {expandedMonitor === monitor.id && (
              <>
                {maintenance && (
                  <Text size="sm" c="yellow" mb="sm">
                    {t('Probe scheduled maintenance')}
                  </Text>
                )}
                {!paused && status !== 'up' && (
                  <Text size="sm" c="dimmed" mb="sm">
                    {t(
                      status === 'down'
                        ? 'Probe all unreachable'
                        : status === 'degraded'
                        ? 'Probe mixed explanation'
                        : 'Probe unknown explanation'
                    )}
                  </Text>
                )}
                {monitor.statusPageLink && (
                  <Text size="sm" mb="sm">
                    <a href={monitor.statusPageLink} target="_blank" rel="noreferrer">
                      {t('Probe open status page')}
                    </a>
                  </Text>
                )}
                {historyReady && (
                  <Box mb="md">
                    <ProbeHistoryChart
                      probes={historyProbes}
                      now={Math.floor(now / 300) * 300}
                      hideLatency={monitor.hideLatencyChart}
                    />
                  </Box>
                )}
                <Accordion
                  multiple
                  variant="contained"
                  value={expandedProbes}
                  onChange={(values) => setExpandedProbes(values.slice(-2))}
                >
                  {probes.map((probe) => (
                    <Accordion.Item key={probe.id} value={probe.id}>
                      <Accordion.Control>
                        <Group justify="space-between" gap="xs">
                          <Group gap={6}>
                            {paused ? (
                              <IconPlayerPause
                                size={20}
                                color={categoryColors.closed}
                                aria-hidden
                              />
                            ) : (
                              <StatusIcon status={probe.status} />
                            )}
                            <Text fw={500}>{probe.name}</Text>
                            {probe.location && (
                              <Text size="xs" c="dimmed">
                                {probe.location}
                              </Text>
                            )}
                          </Group>
                          <Badge
                            color={paused ? categoryColors.closed : statusColors[probe.status]}
                            variant="light"
                          >
                            {t(
                              paused
                                ? 'Historical result'
                                : probe.stale
                                ? 'Probe stale'
                                : probe.latest === null
                                ? 'Probe never reported'
                                : statusLabels[probe.status]
                            )}
                          </Badge>
                        </Group>
                      </Accordion.Control>
                      <Accordion.Panel>
                        {historyReady && expandedProbes.includes(probe.id) && (
                          <ProbeDetails
                            probe={probe}
                            now={now}
                            hideLatency={monitor.hideLatencyChart}
                            monitorId={monitor.id}
                            historical={paused}
                          />
                        )}
                      </Accordion.Panel>
                    </Accordion.Item>
                  ))}
                </Accordion>
              </>
            )}
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>
    </Box>
  )
}
