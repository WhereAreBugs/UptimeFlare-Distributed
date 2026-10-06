import { AsyncLocalStorage } from 'node:async_hooks'
import type { Env } from './index'

type Attributes = Record<string, string | number | boolean>
type Span = { traceId: string; spanId: string; sampled: boolean }
type Context = { env: Env; span: Span; spans: any[] }
const context = new AsyncLocalStorage<Context>()
const MAX_SPANS = 64,
  MAX_SERIES = 64,
  MAX_BYTES = 64 * 1024
const attributes = (values: Attributes) =>
  Object.entries(values).map(([key, v]) => ({
    key,
    value:
      typeof v === 'string'
        ? { stringValue: v }
        : typeof v === 'boolean'
        ? { boolValue: v }
        : { doubleValue: v },
  }))
const nanos = () => String(Date.now()) + '000000'
const id = (bytes: number) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('')
export function parseTraceparent(value?: string | null): Span | undefined {
  const match = /^00-([a-f0-9]{32})-([a-f0-9]{16})-([a-f0-9]{2})$/.exec(value ?? '')
  if (!match || /^0+$/.test(match[1]) || /^0+$/.test(match[2])) return
  return { traceId: match[1], spanId: match[2], sampled: (parseInt(match[3], 16) & 1) === 1 }
}
export function traceparent() {
  const span = context.getStore()?.span
  return span ? `00-${span.traceId}-${span.spanId}-${span.sampled ? '01' : '00'}` : undefined
}
const enabled = (env: Env) =>
  env.TELEMETRY_ENABLED === '1' &&
  !!env.OTEL_EXPORTER_OTLP_ENDPOINT &&
  !!env.OTEL_EXPORTER_OTLP_HEADERS
export function telemetryEnabled(env: Env) {
  return enabled(env)
}
export function route(request: Request) {
  const path = new URL(request.url).pathname
  if (
    path === '/api/probes/ingest' ||
    path === '/api/probes/config' ||
    path === '/api/state' ||
    path === '/api/history'
  )
    return path
  if (path.startsWith('/api/admin/')) return '/api/admin/*'
  if (path.startsWith('/api/manage/')) return '/api/manage/*'
  return path.startsWith('/api/') ? '/api/other' : '/assets'
}

const bounds = [1, 5, 10, 25, 50, 100, 250, 500, 1000, 5000, 10000, 30000, 120000]
type Series = {
  name: string
  attrs: Attributes
  count: number
  sum: number
  min: number
  max: number
  histogram: boolean
  buckets: number[]
}
type Buffer = {
  series: Map<string, Series>
  start: string
  next: number
  exporting: boolean
  failures: number
  dropped: number
  nextFailureLog: number
  env: Env
}
// No D1/KV/DO storage or alarms: bounded, best-effort process telemetry.
const buffers = new Map<string, Buffer>()
function buffer(env: Env) {
  const key = env.OTEL_EXPORTER_OTLP_ENDPOINT! + '\0' + env.OTEL_EXPORTER_OTLP_HEADERS!
  let value = buffers.get(key)
  if (!value) {
    if (buffers.size >= 2) buffers.delete(buffers.keys().next().value!)
    value = {
      series: new Map(),
      start: nanos(),
      next: 0,
      exporting: false,
      failures: 0,
      dropped: 0,
      nextFailureLog: 0,
      env,
    }
    buffers.set(key, value)
  }
  return value
}
export function observe(name: string, value: number, attrs: Attributes = {}, histogram = false) {
  const env = context.getStore()?.env
  if (!env || !enabled(env) || !Number.isFinite(value)) return
  const b = buffer(env),
    key = name + JSON.stringify(attrs)
  let s = b.series.get(key)
  if (!s) {
    if (b.series.size >= MAX_SERIES) {
      b.dropped++
      return
    }
    s = {
      name,
      attrs,
      count: 0,
      sum: 0,
      min: Infinity,
      max: -Infinity,
      histogram,
      buckets: Array(bounds.length + 1).fill(0),
    }
    b.series.set(key, s)
  }
  s.count++
  s.sum += value
  s.min = Math.min(s.min, value)
  s.max = Math.max(s.max, value)
  let i = bounds.findIndex((x) => value <= x)
  s.buckets[i < 0 ? bounds.length : i]++
}
export async function span<T>(
  name: string,
  run: () => Promise<T>,
  attrs: Attributes = {}
): Promise<T> {
  const current = context.getStore()
  if (!current) return run()
  const child = { ...current.span, spanId: current.span.sampled ? id(8) : current.span.spanId }
  const start = nanos(),
    wall = performance.now()
  let failed = false
  try {
    return await context.run({ ...current, span: child }, run)
  } catch (error) {
    failed = true
    throw error
  } finally {
    observe(
      'worker.operation.duration',
      performance.now() - wall,
      { operation: name, success: !failed },
      true
    )
    if (child.sampled && current.spans.length < MAX_SPANS - 1)
      current.spans.push({
        traceId: child.traceId,
        spanId: child.spanId,
        parentSpanId: current.span.spanId,
        name,
        kind: 1,
        startTimeUnixNano: start,
        endTimeUnixNano: nanos(),
        attributes: attributes(attrs),
        status: { code: failed ? 2 : 1 },
      })
  }
}
async function send(env: Env, kind: 'metrics' | 'traces', body: unknown, relay: boolean) {
  const text = JSON.stringify(body)
  if (!relay) return sendDirectTelemetry(env, kind, text)
  if (new TextEncoder().encode(text).byteLength > MAX_BYTES || !env.COORDINATOR_DO) return false
  observe('worker.telemetry.relay.calls', 1, { signal: kind })
  try {
    // The RPC does no persistence or queueing. It avoids zone-specific outbound routing.
    return await env.COORDINATOR_DO.get(env.COORDINATOR_DO.idFromName('state-v2')).exportTelemetry(
      kind,
      text
    )
  } catch {
    return false
  }
}
export async function sendDirectTelemetry(env: Env, kind: 'metrics' | 'traces', text: string) {
  if (!enabled(env) || (kind !== 'metrics' && kind !== 'traces') || typeof text !== 'string')
    return false
  if (new TextEncoder().encode(text).byteLength > MAX_BYTES) return false
  const rejected = (status: number, reason: string) => {
    const b = buffer(env),
      now = Date.now()
    if (now >= b.nextFailureLog) {
      b.nextFailureLog = now + 60000
      console.warn(
        JSON.stringify({ event: 'telemetry_export_failure', signal: kind, status, reason })
      )
    }
    return false
  }
  try {
    const endpoint = new URL(env.OTEL_EXPORTER_OTLP_ENDPOINT!)
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      return false
    const headers = new Headers(JSON.parse(env.OTEL_EXPORTER_OTLP_HEADERS!))
    headers.set('Content-Type', 'application/json')
    headers.set('Content-Encoding', 'gzip')
    headers.set('User-Agent', 'uptimeflare-sre/1')
    const compressed = new Response(text).body!.pipeThrough(new CompressionStream('gzip'))
    const response = await fetch(endpoint.toString().replace(/\/$/, '') + '/v1/' + kind, {
      method: 'POST',
      headers,
      body: await new Response(compressed).arrayBuffer(),
      redirect: 'manual',
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) {
      await response.body?.cancel()
      return rejected(response.status, 'http')
    }
    // OTLP can acknowledge HTTP 200 while rejecting every record. Never log its body.
    const reader = response.body?.getReader()
    if (reader) {
      const chunks: Uint8Array[] = []
      let bytes = 0
      try {
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          bytes += value.byteLength
          if (bytes > 4096) return rejected(response.status, 'oversized_ack')
          chunks.push(value)
        }
      } finally {
        await reader.cancel()
      }
      if (bytes) {
        const result = JSON.parse(chunks.map((chunk) => new TextDecoder().decode(chunk)).join(''))
        const partial = result.partialSuccess ?? result.partial_success
        if (
          partial &&
          Number(
            partial.rejectedSpans ??
              partial.rejected_spans ??
              partial.rejectedDataPoints ??
              partial.rejected_data_points ??
              0
          ) > 0
        )
          return rejected(response.status, 'partial_rejection')
      }
    }
    return true
  } catch {
    return rejected(0, 'transport_or_ack')
  }
}
function resource(env: Env) {
  return {
    attributes: attributes({
      'service.name': 'uptimeflare-distributed',
      'service.version': env.OTEL_SERVICE_VERSION ?? 'unknown',
      'deployment.environment.name': env.OTEL_ENVIRONMENT ?? 'production',
      'cloud.provider': 'cloudflare',
    }),
  }
}
export async function flush(env: Env, force = false, spans: any[] = [], relay = false) {
  if (!enabled(env)) return
  const b = buffer(env),
    now = Date.now()
  const jobs: Promise<boolean>[] = []
  if (spans.length)
    jobs.push(
      send(
        env,
        'traces',
        {
          resourceSpans: [
            {
              resource: resource(env),
              scopeSpans: [{ scope: { name: 'uptimeflare.sre' }, spans }],
            },
          ],
        },
        relay
      ).then((ok) => {
        if (!ok) b.failures++
        return ok
      })
    )
  if (!b.exporting && (force || now >= b.next) && b.series.size) {
    b.exporting = true
    b.next = now + 60000
    const end = nanos(),
      series = [...b.series.values()]
    b.series.clear()
    const metrics = series.map((s) => ({
      name: s.name,
      unit: s.name.endsWith('duration') ? 'ms' : '1',
      ...(s.histogram
        ? {
            histogram: {
              aggregationTemporality: 1,
              dataPoints: [
                {
                  attributes: attributes(s.attrs),
                  startTimeUnixNano: b.start,
                  timeUnixNano: end,
                  count: String(s.count),
                  sum: s.sum,
                  min: s.min,
                  max: s.max,
                  bucketCounts: s.buckets.map(String),
                  explicitBounds: bounds,
                },
              ],
            },
          }
        : {
            sum: {
              aggregationTemporality: 1,
              isMonotonic: true,
              dataPoints: [
                {
                  attributes: attributes(s.attrs),
                  startTimeUnixNano: b.start,
                  timeUnixNano: end,
                  asDouble: s.sum,
                },
              ],
            },
          }),
    }))
    metrics.push({
      name: 'worker.telemetry.export.failures',
      unit: '1',
      sum: {
        aggregationTemporality: 1,
        isMonotonic: true,
        dataPoints: [
          { attributes: [], startTimeUnixNano: b.start, timeUnixNano: end, asDouble: b.failures },
        ],
      },
    })
    metrics.push({
      name: 'worker.telemetry.series.dropped',
      unit: '1',
      sum: {
        aggregationTemporality: 1,
        isMonotonic: true,
        dataPoints: [
          { attributes: [], startTimeUnixNano: b.start, timeUnixNano: end, asDouble: b.dropped },
        ],
      },
    })
    b.start = end
    b.failures = 0
    b.dropped = 0
    jobs.push(
      send(
        env,
        'metrics',
        {
          resourceMetrics: [
            {
              resource: resource(env),
              scopeMetrics: [{ scope: { name: 'uptimeflare.sre' }, metrics }],
            },
          ],
        },
        relay
      ).then((ok) => {
        b.exporting = false
        if (!ok) b.failures++
        return ok
      })
    )
  }
  await Promise.all(jobs)
}
export async function invocation<T>(
  env: Env,
  scope: string,
  run: (env: Env) => Promise<T>,
  options: {
    parent?: string | null
    waitUntil?: (p: Promise<any>) => void
    request?: Request
    force?: boolean
  } = {}
): Promise<T> {
  if (!enabled(env)) return run(env)
  const parent = parseTraceparent(options.parent)
  const rate = Math.max(0, Math.min(1, Number(env.OTEL_TRACES_SAMPLER_ARG ?? '0.05') || 0))
  const root: Span = {
    traceId: parent?.traceId ?? id(16),
    spanId: id(8),
    sampled: parent?.sampled ?? Math.random() < rate,
  }
  const store: Context = { env, span: root, spans: [] },
    start = nanos(),
    wall = performance.now()
  let status = 0,
    failed = false
  try {
    return await context.run(store, async () => {
      const result = await run(env)
      if (result instanceof Response) status = result.status
      return result
    })
  } catch (error) {
    failed = true
    throw error
  } finally {
    const attrs = {
      scope,
      route: options.request ? route(options.request) : scope,
      status: status ? String(Math.floor(status / 100)) + 'xx' : failed ? 'error' : 'ok',
    }
    context.run(store, () => {
      observe('worker.invocations', 1, attrs)
      observe('worker.invocation.duration', performance.now() - wall, attrs, true)
    })
    if (root.sampled)
      store.spans.push({
        traceId: root.traceId,
        spanId: root.spanId,
        ...(parent ? { parentSpanId: parent.spanId } : {}),
        name: scope,
        kind: 2,
        startTimeUnixNano: start,
        endTimeUnixNano: nanos(),
        attributes: attributes({
          ...attrs,
          ...(status ? { 'http.response.status_code': status } : {}),
        }),
        status: { code: failed || status >= 500 ? 2 : 1 },
      })
    const exportTask = context.run(store, () =>
      flush(
        env,
        options.force,
        store.spans,
        scope === 'worker.fetch' && env.OTEL_EXPORTER_USE_COORDINATOR === '1'
      )
    )
    if (options.waitUntil) options.waitUntil(exportTask)
    else await exportTask
  }
}
