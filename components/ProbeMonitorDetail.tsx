import { Accordion, Badge, Box, Group, Stack, Table, Text, Tooltip } from '@mantine/core'
import {
  IconAlertCircle,
  IconAlertTriangle,
  IconCircleCheck,
  IconHelpCircle,
} from '@tabler/icons-react'
import { useTranslation } from 'react-i18next'
import { useState } from 'react'
import type { MonitorTarget } from '@/types/config'
import type { ProbeMonitorSummary, ProbeSummary } from '@/types/probes'
import {
  refreshProbeSummary,
  statusColors,
  summarizeProbeHistory,
  type MonitorStatus,
} from '@/util/probe-status'

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

function emptyProbe(id: string): ProbeSummary {
  return {
    id,
    name: id,
    status: 'unknown',
    stale: false,
    latest: null,
    latencyMs: null,
    checks: 0,
    failures: 0,
    avgLatencyMs: null,
    failureStages: {},
    history: [],
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
  return (
    <div>
      <div
        style={{ display: 'flex', gap: 2, height: 24 }}
        role="group"
        aria-label={`${name} · ${t('Probe history')}`}
      >
        {buckets.map((bucket) => {
          const label = `${new Date(bucket.time * 1000).toLocaleString()}: ${t(
            statusLabels[bucket.status]
          )} · ${
            bucket.checks
              ? t('Probe bucket detail', {
                  checks: bucket.checks,
                  failures: bucket.failures,
                  latency: bucket.avgLatencyMs?.toFixed(1) ?? '—',
                })
              : t('Probe no samples')
          }${
            probes.length > 1
              ? ` · ${t('Probe history coverage', {
                  reported: bucket.reported,
                  total: bucket.total,
                })}`
              : ''
          }`
          return (
            <Tooltip
              key={bucket.time}
              label={label}
              multiline
              events={{ hover: true, focus: true, touch: true }}
            >
              <div
                tabIndex={0}
                role="img"
                aria-label={label}
                style={{
                  flex: 1,
                  minWidth: 1,
                  borderRadius: 2,
                  background: historyColors[bucket.status],
                }}
              />
            </Tooltip>
          )
        })}
      </div>
      <Group justify="space-between" mt={4}>
        <Text size="xs" c="dimmed">
          {t('Probe twelve hours ago')}
        </Text>
        <Text size="xs" c="dimmed">
          {t('Probe now')}
        </Text>
      </Group>
    </div>
  )
}

function ProbeDetails({
  probe,
  now,
  hideLatency,
}: {
  probe: ProbeSummary
  now: number
  hideLatency?: boolean
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
      {!!probe.recentFailures.length && (
        <details onToggle={(event) => setShowFailures(event.currentTarget.open)}>
          <summary style={{ cursor: 'pointer', fontSize: 14 }}>
            {t('Probe recent failures', { count: probe.recentFailures.length })}
          </summary>
          <Text size="xs" c="dimmed" mt={6}>
            {t('Probe failure history limit')}
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
  staleAfterSeconds = 900,
}: {
  monitor: MonitorTarget
  summary?: ProbeMonitorSummary
  now: number
  staleAfterSeconds?: number
}) {
  const { t } = useTranslation('common')
  const [expandedMonitor, setExpandedMonitor] = useState<string | null>(null)
  const [expandedProbes, setExpandedProbes] = useState<string[]>([])
  const current = summary ? refreshProbeSummary(summary, now, staleAfterSeconds) : undefined
  const status = current?.status ?? 'unknown'
  const probes = current?.probes ?? monitor.probes?.map(emptyProbe) ?? []
  const totals = {
    up: current?.up ?? 0,
    down: current?.down ?? 0,
    unknown: current?.unknown ?? probes.length,
    total: probes.length,
  }
  return (
    <Accordion variant="default" mt="sm" value={expandedMonitor} onChange={setExpandedMonitor}>
      <Accordion.Item value={monitor.id}>
        <Accordion.Control>
          <Group justify="space-between" gap="sm" wrap="wrap">
            <Group gap={6}>
              <StatusIcon status={status} />
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
            </Group>
          </Group>
        </Accordion.Control>
        <Box px="md" pb="sm">
          <ProbeHistory probes={probes} name={monitor.name} now={now} />
        </Box>
        <Accordion.Panel>
          {expandedMonitor === monitor.id && (
            <>
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
                          <Text size="xs" c="dimmed">
                            {probe.location ?? probe.id}
                          </Text>
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
