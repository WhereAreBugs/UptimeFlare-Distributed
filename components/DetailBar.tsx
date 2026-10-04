import { MonitorState, MonitorTarget } from '@/types/config'
import { getColor } from '@/util/color'
import { mergeHistorySegments } from '@/util/history-segments'
import { Box, Tooltip, Modal } from '@mantine/core'
import { useMediaQuery, useResizeObserver } from '@mantine/hooks'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import HistorySelectionSummary from './HistorySelectionSummary'
const moment = require('moment')
require('moment-precise-range-plugin')

type NativeHistoryDay = {
  time: number
  percent: string
  monitoredSeconds: number
  downSeconds: number
  reasons: string[]
  color: string
}

export default function DetailBar({
  monitor,
  state,
}: {
  monitor: MonitorTarget
  state: MonitorState
}) {
  const { t } = useTranslation('common')
  const [barRef, barRect] = useResizeObserver()
  const isMobile = useMediaQuery('(max-width: 48em)', false, { getInitialValueInEffect: false })
  const [modalOpened, setModalOpened] = useState(false)
  const [modalTitle, setModalTitle] = useState('')
  const [modelContent, setModelContent] = useState(<div />)
  const [selection, setSelection] = useState<{
    range: string
    reachability: string
    averageLatencyMs: number | null
  } | null>(null)
  useEffect(() => setSelection(null), [monitor.id])

  const overlapLen = (x1: number, x2: number, y1: number, y2: number) => {
    return Math.max(0, Math.min(x2, y2) - Math.max(x1, y1))
  }

  const days: NativeHistoryDay[] = []

  const currentTime = Math.round(Date.now() / 1000)
  const montiorStartTime = state.incident[monitor.id][0].start[0]

  const todayStart = new Date()
  todayStart.setHours(0, 0, 0, 0)

  for (let i = 89; i >= 0; i--) {
    const dayStart = Math.round(todayStart.getTime() / 1000) - i * 86400
    const dayEnd = dayStart + 86400

    const dayMonitorTime = overlapLen(dayStart, dayEnd, montiorStartTime, currentTime)
    let dayDownTime = 0

    let incidentReasons: string[] = []

    for (let incident of state.incident[monitor.id]) {
      const incidentStart = incident.start[0]
      const incidentEnd = incident.end ?? currentTime

      const overlap = overlapLen(dayStart, dayEnd, incidentStart, incidentEnd)
      dayDownTime += overlap

      // Incident history for the day
      if (overlap > 0) {
        for (let i = 0; i < incident.error.length; i++) {
          let partStart = incident.start[i]
          let partEnd =
            i === incident.error.length - 1 ? incident.end ?? currentTime : incident.start[i + 1]
          partStart = Math.max(partStart, dayStart)
          partEnd = Math.min(partEnd, dayEnd)

          if (overlapLen(dayStart, dayEnd, partStart, partEnd) > 0) {
            const startStr = new Date(partStart * 1000).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })
            const endStr = new Date(partEnd * 1000).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })
            incidentReasons.push(`[${startStr}-${endStr}] ${incident.error[i]}`)
          }
        }
      }
    }

    const dayPercent = (((dayMonitorTime - dayDownTime) / dayMonitorTime) * 100).toPrecision(4)

    days.push({
      time: dayStart,
      percent: dayPercent,
      monitoredSeconds: dayMonitorTime,
      downSeconds: dayDownTime,
      reasons: incidentReasons,
      color: getColor(dayPercent, false),
    })
  }

  const dayLabel = (day: NativeHistoryDay) =>
    Number.isNaN(Number(day.percent)) ? (
      t('No Data')
    ) : (
      <>
        <div>
          {t('percent at date', {
            percent: day.percent,
            date: new Date(day.time * 1000).toLocaleDateString(),
          })}
        </div>
        {day.downSeconds > 0 && (
          <div>
            {t('Down for', {
              duration: moment.preciseDiff(moment(0), moment(day.downSeconds * 1000)),
            })}
          </div>
        )}
      </>
    )

  // Native history measures elapsed time, not reported check counts. Reuse only
  // the segment geometry; retain every original day and its incident details.
  const segments = isMobile
    ? mergeHistorySegments(
        days.map((day) => ({ time: day.time, status: day.color, checks: 0, failures: 0 })),
        86400
      )
    : []

  const uptimePercentBars =
    !isMobile &&
    days.map((day) => (
      <Tooltip
        multiline
        key={day.time}
        events={{ hover: true, focus: false, touch: true }}
        label={dayLabel(day)}
      >
        <div
          style={{
            height: '20px',
            width: '7px',
            background: day.color,
            borderRadius: '2px',
            marginLeft: '1px',
            marginRight: '1px',
          }}
          onClick={() => {
            if (day.downSeconds > 0) {
              setModalTitle(
                t('incidents at', {
                  name: monitor.name,
                  date: new Date(day.time * 1000).toLocaleDateString(),
                })
              )
              setModelContent(
                <>
                  {day.reasons.map((reason, index) => (
                    <div key={index} style={{ overflowWrap: 'anywhere' }}>
                      {reason}
                    </div>
                  ))}
                </>
              )
              setModalOpened(true)
            }
          }}
        />
      </Tooltip>
    ))

  return (
    <>
      {!isMobile && (
        <Modal
          opened={modalOpened}
          onClose={() => setModalOpened(false)}
          title={modalTitle}
          size={'40em'}
        >
          {modelContent}
        </Modal>
      )}
      <Box
        style={{
          display: 'flex',
          flexWrap: 'nowrap',
          width: '100%',
          minWidth: 0,
          marginTop: '10px',
          marginBottom: '5px',
          ...(isMobile && { height: 20, overflow: 'hidden', borderRadius: 2 }),
        }}
        role="group"
        aria-label={`${monitor.name} · ${t('Probe ninety day uptime')}`}
        ref={barRef}
      >
        {isMobile
          ? segments.map((segment) => {
              const members = days.slice(segment.firstIndex, segment.lastIndex + 1)
              const firstDate = new Date(segment.startTime * 1000).toLocaleDateString()
              const lastDate = new Date(
                members[members.length - 1].time * 1000
              ).toLocaleDateString()
              const dateRange = firstDate === lastDate ? firstDate : `${firstDate} – ${lastDate}`
              const monitored = members.reduce((total, day) => total + day.monitoredSeconds, 0)
              const down = members.reduce((total, day) => total + day.downSeconds, 0)
              const reachability = t(
                monitored === 0
                  ? 'Probe unknown'
                  : down === 0
                  ? 'Probe operational'
                  : down >= monitored
                  ? 'Probe unreachable'
                  : 'Probe partial reachability'
              )
              return (
                <button
                  key={segment.startTime}
                  type="button"
                  aria-label={`${dateRange} · ${reachability}`}
                  aria-pressed={selection?.range === dateRange}
                  style={{
                    // All days have the same duration; no fixed gaps or minimum
                    // widths may distort their proportional share of the timeline.
                    flex: `${segment.bucketCount} 1 0`,
                    minWidth: 0,
                    height: 20,
                    padding: 0,
                    border: 0,
                    margin: 0,
                    background: segment.status,
                    cursor: 'pointer',
                    outlineOffset: -2,
                  }}
                  onClick={() => {
                    const failures = state.incident[monitor.id].filter(
                      (incident) =>
                        incident.error[0] !== 'dummy' &&
                        incident.start[0] < segment.endTime &&
                        (incident.end === null || incident.end > segment.startTime)
                    )
                    let latencySum = 0
                    let latencyCount = 0
                    for (const sample of state.latency[monitor.id] ?? []) {
                      if (
                        !(sample.time >= segment.startTime && sample.time < segment.endTime) ||
                        !Number.isFinite(sample.ping) ||
                        sample.ping < 0
                      )
                        continue
                      if (
                        failures.some(
                          (incident) =>
                            incident.start[0] <= sample.time &&
                            (incident.end === null || sample.time < incident.end)
                        )
                      )
                        continue
                      latencySum += sample.ping
                      latencyCount++
                    }
                    // Freeze the selected values at click time, including null
                    // when this retained day range has no successful samples.
                    setSelection({
                      range: dateRange,
                      reachability,
                      averageLatencyMs: latencyCount ? latencySum / latencyCount : null,
                    })
                  }}
                />
              )
            })
          : uptimePercentBars &&
            uptimePercentBars.slice(Math.floor(Math.max(9 * 90 - barRect.width, 0) / 9), 90)}
      </Box>
      {isMobile && (
        <Box
          style={{ display: 'flex', justifyContent: 'space-between', minWidth: 0, fontSize: 12 }}
          aria-hidden="true"
        >
          <span>{new Date(days[0].time * 1000).toLocaleDateString()}</span>
          <span>{new Date(days[days.length - 1].time * 1000).toLocaleDateString()}</span>
        </Box>
      )}
      {isMobile && selection && <HistorySelectionSummary {...selection} />}
    </>
  )
}
