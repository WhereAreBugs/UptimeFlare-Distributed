import { Tooltip } from '@mantine/core'
import { useMediaQuery } from '@mantine/hooks'
import {
  mergeHistorySegments,
  type HistorySegment,
  type HistorySegmentBucket,
} from '@/util/history-segments'
import classes from '@/styles/HistoryTimeline.module.css'

/** Preserve individual desktop buckets; compact mobile runs retain their source indices. */
export default function HistoryTimeline<Status extends string>({
  buckets,
  bucketSeconds,
  ariaLabel,
  height,
  color,
  label,
  compactLabel,
  href,
  onSelect,
}: {
  buckets: readonly HistorySegmentBucket<Status>[]
  bucketSeconds: number
  ariaLabel: string
  height: number
  color: (status: Status) => string
  label: (segment: HistorySegment<Status>) => string
  compactLabel: (segment: HistorySegment<Status>) => string
  href?: (segment: HistorySegment<Status>) => string
  onSelect: (segment: HistorySegment<Status>) => void
}) {
  const compact = useMediaQuery('(max-width: 48em)', false, { getInitialValueInEffect: false })
  const segments = compact
    ? mergeHistorySegments(buckets, bucketSeconds)
    : buckets.map((bucket, index) => ({
        ...mergeHistorySegments([bucket], bucketSeconds)[0],
        firstIndex: index,
        lastIndex: index,
      }))
  return (
    <div className={classes.timeline} style={{ height }} role="group" aria-label={ariaLabel}>
      {segments.map((segment) => {
        const description = compact ? compactLabel(segment) : label(segment)
        const shared = {
          className: classes.segment,
          'aria-label': description,
          style: { flexGrow: segment.bucketCount, background: color(segment.status) },
        }
        if (compact)
          return (
            <button
              {...shared}
              key={segment.startTime}
              type="button"
              onClick={() => onSelect(segment)}
            />
          )
        return (
          <Tooltip
            key={segment.startTime}
            label={description}
            multiline
            events={{ hover: true, focus: true, touch: true }}
          >
            {href ? (
              <a {...shared} href={href(segment)} />
            ) : (
              <div {...shared} tabIndex={0} role="img" />
            )}
          </Tooltip>
        )
      })}
    </div>
  )
}
