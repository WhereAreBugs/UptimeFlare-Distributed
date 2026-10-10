import { observe, span, telemetryEnabled, traceparent } from './telemetry'
import type { Env } from './index'
export type ResourceCounts = {
  sql: number
  rowsRead: number
  rowsWritten: number
  rowsReturned: number
  doRequests: number
  doDurationMs: number
}
/** Optional numerical telemetry only. Never log SQL text, bindings, identities or errors. */
export function measureDatabase(database: D1Database, counts: ResourceCounts): D1Database {
  const underlying = new WeakMap<object, D1PreparedStatement>()
  const record = (r: any) => {
    counts.sql++
    counts.rowsRead += r.meta?.rows_read ?? 0
    counts.rowsWritten += r.meta?.rows_written ?? 0
    counts.rowsReturned += r.results?.length ?? 0
  }
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const result = new Proxy(statement, {
      get(target, key) {
        if (key === 'bind') return (...args: any[]) => wrap(target.bind(...args))
        if (key === 'first')
          return async (column?: string) => {
            const r = await span('d1.first', () => target.all())
            record(r)
            const row: any = r.results?.[0]
            return row ? (column === undefined ? row : row[column]) : null
          }
        if (key === 'all' || key === 'run')
          return async (...args: any[]) => {
            const r = await span('d1.' + key, () => (target as any)[key](...args))
            record(r)
            return r
          }
        const value = Reflect.get(target, key)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
    underlying.set(result, statement)
    return result
  }
  const wrapper = new Proxy(database, {
    get(target, key) {
      if (key === 'prepare') return (sql: string) => wrap(target.prepare(sql))
      if (key === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          const r = await span('d1.batch', () =>
            target.batch(statements.map((s) => underlying.get(s) ?? s))
          )
          r.forEach(record)
          return r
        }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  identities.set(wrapper, resourceIdentity(database))
  return wrapper
}
const identities = new WeakMap<object, object>()
export const resourceIdentity = (value: object) => identities.get(value) ?? value
const namespaces = new WeakMap<object, object>()
export const namespaceIdentity = (value: object) => namespaces.get(value) ?? value
function measureNamespace(namespace: any, counts: ResourceCounts) {
  const wrapper = new Proxy(namespace, {
    get(target, key) {
      if (key === 'get')
        return (...args: any[]) => {
          const stub = target.get(...args)
          return new Proxy(stub, {
            get(obj, method) {
              const value = Reflect.get(obj, method)
              if (typeof value !== 'function') return value
              return async (...params: any[]) => {
                counts.doRequests++
                const start = performance.now()
                try {
                  return await span('rpc.' + String(method), async () => {
                    const parent = traceparent()
                    return Reflect.apply(value, obj, parent ? [...params, parent] : params)
                  })
                } finally {
                  counts.doDurationMs += performance.now() - start
                }
              }
            },
          })
        }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  namespaces.set(wrapper, namespaceIdentity(namespace))
  return wrapper
}
export async function withResources<T>(
  env: Env,
  scope: 'root-fetch' | 'root-cron' | 'coordinator',
  run: (env: Env) => Promise<T>
): Promise<T> {
  if (env.METRICS_ENABLED !== '1' && !telemetryEnabled(env)) return run(env)
  const counts: ResourceCounts = {
      sql: 0,
      rowsRead: 0,
      rowsWritten: 0,
      rowsReturned: 0,
      doRequests: 0,
      doDurationMs: 0,
    },
    start = performance.now()
  const measured = {
    ...env,
    UPTIMEFLARE_D1: measureDatabase(env.UPTIMEFLARE_D1, counts),
    ...(env.UPTIMEFLARE_PUBLIC_KV && {
      UPTIMEFLARE_PUBLIC_KV: measureKV(env.UPTIMEFLARE_PUBLIC_KV),
    }),
    ...(env.COORDINATOR_DO && { COORDINATOR_DO: measureNamespace(env.COORDINATOR_DO, counts) }),
    ...(env.REMOTE_CHECKER_DO && {
      REMOTE_CHECKER_DO: measureNamespace(env.REMOTE_CHECKER_DO, counts),
    }),
  }
  try {
    return await run(measured)
  } finally {
    observe('worker.d1.queries', counts.sql, { scope })
    observe('worker.d1.rows.read', counts.rowsRead, { scope })
    observe('worker.d1.rows.written', counts.rowsWritten, { scope })
    observe('worker.d1.rows.returned', counts.rowsReturned, { scope })
    observe('worker.rpc.calls', counts.doRequests, { scope })
    observe('worker.rpc.duration', counts.doDurationMs, { scope }, true)
    if (env.METRICS_ENABLED === '1')
      console.log(
        JSON.stringify({
          event: 'resource_counts',
          scope,
          ...counts,
          wallDurationMs: performance.now() - start,
        })
      )
  }
}

function measureKV(namespace: KVNamespace): KVNamespace {
  const wrapper = new Proxy(namespace, {
    get(target, key) {
      const value = Reflect.get(target, key)
      if (typeof value !== 'function') return value
      return async (...args: any[]) => {
        const operation = ['get', 'getWithMetadata', 'put', 'delete', 'list'].includes(String(key))
          ? String(key)
          : 'other'
        observe('worker.kv.operations', 1, { operation })
        return span('kv.' + operation, async () => Reflect.apply(value, target, args))
      }
    },
  })
  identities.set(wrapper, resourceIdentity(namespace))
  return wrapper
}
