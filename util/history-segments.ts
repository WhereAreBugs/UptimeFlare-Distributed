export type HistorySegmentBucket<Status extends string = string> = {
  /** Unix seconds; buckets stay in their original display order. */
  time: number
  status: Status
  checks: number
  failures: number
  avgLatencyMs?: number | null
  /** Successful latency samples, when the source provides a separate count. */
  latencyChecks?: number
}

export type HistorySegment<Status extends string = string> = {
  status: Status
  /** Inclusive indices, allowing tooltips to read the unmodified source buckets. */
  firstIndex: number
  lastIndex: number
  startTime: number
  /** Exclusive end of the final bucket. */
  endTime: number
  bucketCount: number
  /** Original bucket count / total bucket count; gaps never gain extra width. */
  widthRatio: number
  checks: number
  failures: number
  latencyChecks: number
  avgLatencyMs: number | null
}

/** Merge contiguous equal-status buckets without sorting, filling gaps or inferring status. */
export function mergeHistorySegments<Status extends string>(
  buckets: readonly HistorySegmentBucket<Status>[],
  bucketSeconds: number
): HistorySegment<Status>[] {
  if (!Number.isFinite(bucketSeconds) || bucketSeconds <= 0)
    throw new RangeError('History bucket duration must be positive and finite')

  const segments: HistorySegment<Status>[] = []
  let latencySum = 0
  for (let index = 0; index < buckets.length; index++) {
    const bucket = buckets[index]
    const average = bucket.avgLatencyMs
    // Five-minute averages represent wholly successful buckets. Daily buckets
    // explicitly count their successful latency samples, including mixed days.
    const latencyChecks =
      average === null || average === undefined
        ? 0
        : bucket.latencyChecks ?? (bucket.failures === 0 ? bucket.checks : 0)
    const weightedLatency = (average ?? 0) * latencyChecks
    const previous = segments[segments.length - 1]
    if (previous?.status === bucket.status && previous.endTime === bucket.time) {
      previous.lastIndex = index
      previous.endTime = bucket.time + bucketSeconds
      previous.bucketCount++
      previous.checks += bucket.checks
      previous.failures += bucket.failures
      previous.latencyChecks += latencyChecks
      latencySum += weightedLatency
      previous.avgLatencyMs = previous.latencyChecks ? latencySum / previous.latencyChecks : null
    } else {
      latencySum = weightedLatency
      segments.push({
        status: bucket.status,
        firstIndex: index,
        lastIndex: index,
        startTime: bucket.time,
        endTime: bucket.time + bucketSeconds,
        bucketCount: 1,
        widthRatio: 0,
        checks: bucket.checks,
        failures: bucket.failures,
        latencyChecks,
        avgLatencyMs: latencyChecks ? weightedLatency / latencyChecks : null,
      })
    }
  }
  for (const segment of segments) segment.widthRatio = segment.bucketCount / buckets.length
  return segments
}
