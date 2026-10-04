import type { MonitorTarget } from '../../types/config'
import type { ScheduledBudget } from './scheduling'
/** Reserve headroom for location, publication and notification delivery per invocation. */
export function createExecutionBudget(): ScheduledBudget {
  return { remaining: 200, locations: new Map([['root', 30]]) }
}
export function admitByLocation(monitors: MonitorTarget[], budget: ScheduledBudget) {
  if (!budget.locations) return monitors
  const admitted: MonitorTarget[] = [],
    regional = new Map<string, number>()
  for (const monitor of monitors) {
    const proxy = monitor.checkProxy ?? '',
      isRegional = proxy.startsWith('worker://'),
      location = isRegional ? proxy : 'root'
    const remoteCount = regional.get(location) ?? 0
    const cost = proxy.startsWith('globalping://') ? 20 : proxy && !isRegional ? 2 : 1
    const remaining = budget.locations.get(location) ?? 40
    const root = budget.locations.get('root') ?? 0
    const rpcCost = isRegional && remoteCount % 40 === 0 ? 1 : 0
    const fallbackCost = isRegional && monitor.checkProxyFallback ? 1 : 0
    if (remaining < cost || (isRegional && root < rpcCost + fallbackCost)) continue
    budget.locations.set(location, remaining - cost)
    if (isRegional) {
      regional.set(location, remoteCount + 1)
      budget.locations.set('root', root - rpcCost - fallbackCost)
    }
    admitted.push(monitor)
  }
  return admitted
}
