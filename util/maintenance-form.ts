type LocalParts = Record<'year' | 'month' | 'day' | 'hour' | 'minute' | 'second', number>

export function validMaintenanceTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone }).format()
    return timeZone.length > 0
  } catch {
    return false
  }
}

function formatter(timeZone: string) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  })
}
function partsAt(value: number, format: Intl.DateTimeFormat): LocalParts {
  return Object.fromEntries(
    format
      .formatToParts(value)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)])
  ) as LocalParts
}
const wallTime = (parts: LocalParts) =>
  Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)

/** Preserve incomplete or invalid drafts until validation, without silently shifting DST gaps. */
export function formatMaintenanceDateTime(
  value: number | string | undefined,
  timeZone: string
): string {
  if (value === undefined || value === '') return ''
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return value
  const time = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value)
  if (!Number.isFinite(time) || !validMaintenanceTimeZone(timeZone)) return ''
  const parts = partsAt(time, formatter(timeZone))
  const pad = (number: number) => String(number).padStart(2, '0')
  return `${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(
    parts.minute
  )}`
}

/** Interpret a datetime-local value in an explicit IANA zone and store an absolute ISO instant. */
export function parseMaintenanceDateTime(value: string, timeZone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value)
  if (!match || !validMaintenanceTimeZone(timeZone)) return null
  const [year, month, day, hour, minute] = match.slice(1).map(Number)
  const expected = wallTime({ year, month, day, hour, minute, second: 0 })
  const format = formatter(timeZone)
  let instant = expected
  for (let attempt = 0; attempt < 4; attempt++) {
    const parts = partsAt(instant, format)
    const difference = expected - wallTime(parts)
    if (difference === 0) {
      if (
        parts.year !== year ||
        parts.month !== month ||
        parts.day !== day ||
        parts.hour !== hour ||
        parts.minute !== minute
      )
        return null
      return new Date(instant).toISOString()
    }
    instant += difference
  }
  return null
}
