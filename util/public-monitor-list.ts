import type { MonitorTarget, PageConfigGroup } from '../types/config'
import type { ProbeMonitorSummary } from '../types/probes'

export const MONITORS_PER_PAGE = 10

export function visiblePublicMonitors(
  monitors: readonly MonitorTarget[],
  summaries: Record<string, ProbeMonitorSummary>
): MonitorTarget[] {
  return monitors.filter(
    (monitor) =>
      !monitor.paused &&
      !summaries[monitor.id]?.paused &&
      summaries[monitor.id]?.status !== 'paused'
  )
}

/** Build groups once from ordered IDs, and omit groups with no active members. */
export function publicMonitorGroups(
  monitors: readonly MonitorTarget[],
  groups: PageConfigGroup,
  otherName: string
): { name: string; monitors: MonitorTarget[] }[] {
  const byId = new Map(monitors.map((monitor) => [monitor.id, monitor]))
  const assigned = new Set<string>()
  const result = Object.entries(groups).flatMap(([name, ids]) => {
    const members = Array.from(new Set(ids)).flatMap((id) => {
      const monitor = byId.get(id)
      if (!monitor) return []
      assigned.add(id)
      return [monitor]
    })
    return members.length ? [{ name, monitors: members }] : []
  })
  const ungrouped = monitors.filter((monitor) => !assigned.has(monitor.id))
  if (Object.keys(groups).length && ungrouped.length) {
    let name = otherName
    let suffix = 2
    while (Object.hasOwn(groups, name)) name = `${otherName} (${suffix++})`
    result.push({ name, monitors: ungrouped })
  }
  return result
}

/** Bound mounted cards even when all targets are assigned to one group. */
export function publicMonitorPage<T>(
  items: readonly T[],
  requestedPage: number,
  size = MONITORS_PER_PAGE
) {
  if (!Number.isInteger(size) || size < 1) throw new Error('Invalid monitor page size')
  const pages = Math.ceil(items.length / size)
  const page = Math.max(1, Math.min(pages || 1, Math.floor(requestedPage) || 1))
  return { items: items.slice((page - 1) * size, page * size), page, pages }
}
