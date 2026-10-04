import { Accordion, Badge, Box, Group, Modal, Stack, Table, Text, Tooltip } from '@mantine/core'
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconCircleCheck,
  IconHelpCircle,
} from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import type { MaintenanceConfig, MonitorTarget } from '@/types/config'
import type { ProbeMonitorSummary, ProbeSummary } from '@/types/probes'
import {
  refreshProbeSummary,
  statusColors,
  summarizeProbeHistory,
  summarizeProbeDailyHistory,
  type MonitorStatus,
} from '@/util/probe-status'
import ProbeHistoryChart from './ProbeHistoryChart'
import ProbeDailyHistory from './ProbeDailyHistory'
import HistoryTimeline from './HistoryTimeline'
import type { HistorySegment } from '@/util/history-segments'
import { maintenances as fallbackMaintenances } from '@/uptime.config'

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

function ProbeHistory({
  probes,
  name,
  now,
}: {
  probes: ProbeSummary[]
  name: string
  now: number
}) {
  const { t } = useTranslation('common')
  const buckets = summarizeProbeHistory(probes, now)
  const [selected, setSelected] = useState<{
    segment: HistorySegment<MonitorStatus>
    buckets: ReturnType<typeof summarizeProbeHistory>
  } | null>(null)
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
        onSelect={(segment) =>
          setSelected({
            segment,
            buckets: buckets.slice(segment.firstIndex, segment.lastIndex + 1),
          })
        }
      />
      <Group justify="space-between" mt={4}>
        <Text size="xs" c="dimmed">
          {t('Probe twelve hours ago')}
        </Text>
        <Text size="xs" c="dimmed">
          {t('Probe now')}
        </Text>
      </Group>
      <Modal opened={selected !== null} onClose={() => setSelected(null)} title={name}>
        {selected && (
          <Stack gap="sm">
            <Text size="sm">{label(selected.segment, selected.buckets)}</Text>
            <div style={{ maxHeight: '60vh', overflowY: 'auto' }}>
              {selected.buckets.map((bucket) => (
                <Text key={bucket.time} size="xs" mb="sm">
                  {new Date(bucket.time * 1000).toLocaleString()}
                  {' · '}
                  {bucket.checks
                    ? t('Probe bucket detail', {
                        checks: bucket.checks,
                        failures: bucket.failures,
                        latency: bucket.avgLatencyMs?.toFixed(1) ?? '—',
                      })
                    : t('Probe no samples')}
                  {bucket.total > 1 &&
                    ` · ${t('Probe history coverage', {
                      reported: bucket.reported,
                      total: bucket.total,
                    })}`}
                </Text>
              ))}
            </div>
          </Stack>
        )}
      </Modal>
    </div>
  )
}

function ProbeDetails({
  probe,
  now,
  hideLatency,
  monitorId,
}: {
  probe: ProbeSummary
  now: number
  hideLatency?: boolean
  monitorId: string
}) {
  const { t } = useTranslation('common')
  const [showFailures, setShowFailures] = useState(false)
  const stageLabel = (stage: string) => t(`Probe stage ${stage}`, { defaultValue: stage })
  return (
    <Stack gap="sm">
      {probe.stale && (
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
}: {
  monitor: MonitorTarget
  summary?: ProbeMonitorSummary
  now: number
  maintenances?: MaintenanceConfig[]
}) {
  const { t } = useTranslation('common')
  const [expandedMonitor, setExpandedMonitor] = useState<string | null>(null)
  const [expandedProbes, setExpandedProbes] = useState<string[]>([])
  const current = summary ? refreshProbeSummary(summary, now, monitor) : undefined
  const status = current?.status ?? 'unknown'
  const probes = current?.probes ?? monitor.probes?.map(emptyProbe) ?? []
  const maintenance = maintenances.find(
    (entry) =>
      (!entry.monitors?.length || entry.monitors.includes(monitor.id)) &&
      new Date(entry.start).getTime() <= now * 1000 &&
      (!entry.end || new Date(entry.end).getTime() >= now * 1000)
  )
  const totals = {
    up: current?.up ?? 0,
    total: (current?.up ?? 0) + (current?.down ?? 0),
  }
  return (
    <Accordion variant="default" mt="sm" value={expandedMonitor} onChange={setExpandedMonitor}>
      <Accordion.Item value={monitor.id}>
        <Accordion.Control>
          <Group justify="space-between" gap="sm" wrap="wrap">
            <Group gap={6}>
              {maintenance ? (
                <IconAlertTriangle size={20} color="#fab005" aria-hidden />
              ) : (
                <StatusIcon status={status} />
              )}
              <Tooltip label={monitor.tooltip} disabled={!monitor.tooltip}>
                <Text fw={700}>{monitor.name}</Text>
              </Tooltip>
            </Group>
            <Group gap="xs">
              <Badge color={statusColors[status]} variant="light">
                {t(statusLabels[status])}
              </Badge>
              <Text size="sm" c="dimmed">
                {t('Probe summary counts', totals)}
              </Text>
              <Text size="sm" fw={600}>
                {current?.uptimePercent === null || current?.uptimePercent === undefined
                  ? t('No Data')
                  : t('Overall', { percent: current.uptimePercent.toFixed(3) })}
              </Text>
            </Group>
          </Group>
        </Accordion.Control>
        <Box px="md" pb="sm">
          <ProbeHistory probes={probes} name={monitor.name} now={now} />
          <Box mt="sm">
            <ProbeDailyHistory
              days={summarizeProbeDailyHistory(probes, now)}
              monitorId={monitor.id}
            />
          </Box>
        </Box>
        <Accordion.Panel>
          {expandedMonitor === monitor.id && (
            <>
              {maintenance && (
                <Text size="sm" c="yellow" mb="sm">
                  {t('Probe scheduled maintenance')}
                </Text>
              )}
              {status !== 'up' && (
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
              <Box mb="md">
                <ProbeHistoryChart
                  probes={probes}
                  now={now}
                  hideLatency={monitor.hideLatencyChart}
                />
              </Box>
              <Accordion
                multiple
                variant="contained"
                value={expandedProbes}
                onChange={setExpandedProbes}
              >
                {probes.map((probe) => (
                  <Accordion.Item key={probe.id} value={probe.id}>
                    <Accordion.Control>
                      <Group justify="space-between" gap="xs">
                        <Group gap={6}>
                          <StatusIcon status={probe.status} />
                          <Text fw={500}>{probe.name}</Text>
                          {probe.location && (
                            <Text size="xs" c="dimmed">
                              {probe.location}
                            </Text>
                          )}
                        </Group>
                        <Badge color={statusColors[probe.status]} variant="light">
                          {t(
                            probe.stale
                              ? 'Probe stale'
                              : probe.latest === null
                              ? 'Probe never reported'
                              : statusLabels[probe.status]
                          )}
                        </Badge>
                      </Group>
                    </Accordion.Control>
                    <Accordion.Panel>
                      {expandedProbes.includes(probe.id) && (
                        <ProbeDetails
                          probe={probe}
                          now={now}
                          hideLatency={monitor.hideLatencyChart}
                          monitorId={monitor.id}
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
  )
}
