import type { MaintenanceConfig, WorkerConfig } from '../types/config'
import { maintenances as fallbackMaintenances, pageConfig as fallbackPage } from '../uptime.config'

export function maintenanceTime(value: number | string): number {
  return typeof value === 'number'
    ? value < 1e12 ? value : value / 1000
    : Date.parse(value) / 1000
}

type Parts = { year: number; month: number; day: number; hour: number; minute: number; second: number }
function partsAt(time: number, formatter: Intl.DateTimeFormat): Parts {
  return Object.fromEntries(formatter.formatToParts(new Date(time * 1000))
    .filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)])) as Parts
}
const wall = (p: Parts) => Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) / 1000
function zonedTime(parts: Parts, formatter: Intl.DateTimeFormat): number | null {
  const expected = wall(parts)
  let value = expected
  for (let i = 0; i < 4; i++) {
    const difference = expected - wall(partsAt(value, formatter))
    if (difference === 0) return value
    value += difference
  }
  // A nonexistent spring-forward wall time is skipped, rather than silently moved.
  return null
}

/** Expand only the requested window; preserve local wall-clock time across DST. */
export function expandMaintenances(plans: MaintenanceConfig[], from: number, to: number): MaintenanceConfig[] {
  const results: MaintenanceConfig[] = []
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from || to - from > 125 * 86400)
    throw new Error('Maintenance window must be at most 125 days')
  for (const plan of plans) {
    const start = maintenanceTime(plan.start)
    const end = plan.end === undefined ? Infinity : maintenanceTime(plan.end)
    if (!plan.repeat) {
      if (start < to && end >= from) results.push({ ...plan, start: new Date(start * 1000).toISOString(),
        ...(Number.isFinite(end) && { end: new Date(end * 1000).toISOString() }) })
      continue
    }
    const duration = end - start
    if (!Number.isFinite(duration) || duration <= 0 || duration > 7 * 86400) continue
    const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: plan.repeat.timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
      second: '2-digit', hourCycle: 'h23' })
    const anchor = partsAt(start, formatter)
    const first = partsAt(Math.max(start, from - duration), formatter)
    const day = new Date(Date.UTC(first.year, first.month - 1, first.day))
    const anchorWeekday = new Date(Date.UTC(anchor.year, anchor.month - 1, anchor.day)).getUTCDay()
    // A window is bounded and never iterates from an ancient schedule's original start.
    for (let i = 0; i < 135; i++, day.setUTCDate(day.getUTCDate() + 1)) {
      const year = day.getUTCFullYear(), month = day.getUTCMonth() + 1, date = day.getUTCDate()
      if (day.getTime()/1000 > to + 86400) break
      if (plan.repeat.frequency === 'weekly' && day.getUTCDay() !== anchorWeekday) continue
      if (plan.repeat.frequency === 'monthly' && date !== Math.min(anchor.day, new Date(Date.UTC(year, month, 0)).getUTCDate())) continue
      const candidate = { ...anchor, year, month, day: date }
      const occurrence = zonedTime(candidate, formatter)
      if (occurrence !== null && occurrence >= to) break
      if (occurrence === null || occurrence < start || occurrence + duration < from) continue
      results.push({ ...plan, repeat: undefined, start: new Date(occurrence * 1000).toISOString(),
        end: new Date((occurrence + duration) * 1000).toISOString() })
    }
  }
  return results.sort((a, b) => maintenanceTime(a.start) - maintenanceTime(b.start))
}

export function isInMaintenance(config: WorkerConfig, monitorId: string, now: number): boolean {
  return expandMaintenances(config.maintenances ?? fallbackMaintenances, now - 1, now + 1)
    .some(plan => maintenanceTime(plan.start) <= now && (plan.end === undefined || maintenanceTime(plan.end) >= now)
      && (!plan.monitors?.length || plan.monitors.includes(monitorId)))
}

export function getPresentationSettings(config: WorkerConfig) {
  return { page: config.page ?? fallbackPage, maintenances: config.maintenances ?? fallbackMaintenances }
}
