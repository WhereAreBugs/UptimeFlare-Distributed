import { expect, it, vi, afterEach } from 'vitest'
import { gunzipSync } from 'node:zlib'
import { invocation, observe, span, traceparent, parseTraceparent } from '../src/telemetry'
import type { Env } from '../src/index'
afterEach(() => vi.unstubAllGlobals())
it('counts partial OTLP rejection and bounds safe failure logging', async () => {
  const logs = vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: any) => {
      expect(init.headers.get('User-Agent')).toBe('uptimeflare-sre/1')
      return Response.json({ partialSuccess: { rejectedSpans: '1', errorMessage: 'SECRET' } })
    })
  )
  const env = {
    TELEMETRY_ENABLED: '1',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://partial.invalid',
    OTEL_EXPORTER_OTLP_HEADERS: '{}',
    OTEL_TRACES_SAMPLER_ARG: '1',
  } as Env
  try {
    await invocation(env, 'worker.fetch', async () => 42, { force: true })
    expect(logs).toHaveBeenCalledTimes(1)
    expect(JSON.parse(logs.mock.calls[0][0])).toMatchObject({
      event: 'telemetry_export_failure',
      reason: 'partial_rejection',
    })
    expect(JSON.stringify(logs.mock.calls)).not.toContain('SECRET')
  } finally {
    logs.mockRestore()
  }
})
it('exports gzip OTLP with a continuous parent chain and operational metrics only', async () => {
  const exports: any[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: any) => {
      exports.push({ url, body: JSON.parse(gunzipSync(new Uint8Array(init.body)).toString()) })
      return new Response('{}')
    })
  )
  const env = {
    TELEMETRY_ENABLED: '1',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.invalid/api/default',
    OTEL_EXPORTER_OTLP_HEADERS: JSON.stringify({ Authorization: 'secret' }),
    OTEL_TRACES_SAMPLER_ARG: '1',
  } as Env
  const pending: Promise<any>[] = []
  const parent = '00-11111111111111111111111111111111-2222222222222222-01'
  await invocation(
    env,
    'worker.fetch',
    async () =>
      span('rpc.commitProbe', async () => {
        const propagated = traceparent()!
        await invocation(
          env,
          'coordinator.commitProbe',
          async () => {
            observe('worker.d1.rows.written', 4)
            return span('d1.batch', async () => true)
          },
          { parent: propagated, force: true, waitUntil: (p) => pending.push(p) }
        )
        return new Response('ok')
      }),
    { parent, force: true, waitUntil: (p) => pending.push(p) }
  )
  await Promise.all(pending)
  const spans = exports.flatMap(
    (x) =>
      x.body.resourceSpans?.flatMap((r: any) => r.scopeSpans.flatMap((s: any) => s.spans)) ?? []
  )
  const root = spans.find((x) => x.name === 'worker.fetch'),
    rpc = spans.find((x) => x.name === 'rpc.commitProbe'),
    doRoot = spans.find((x) => x.name === 'coordinator.commitProbe'),
    d1 = spans.find((x) => x.name === 'd1.batch')
  expect(root.parentSpanId).toBe('2222222222222222')
  expect(rpc.parentSpanId).toBe(root.spanId)
  expect(doRoot.parentSpanId).toBe(rpc.spanId)
  expect(d1.parentSpanId).toBe(doRoot.spanId)
  expect(spans.every((x) => x.traceId === '11111111111111111111111111111111')).toBe(true)
  expect(exports.some((x) => x.body.resourceMetrics)).toBe(true)
  expect(JSON.stringify(exports)).not.toContain('secret')
})
it('does no network work when disabled and isolates exporter errors from application results', async () => {
  const send = vi.fn(async () => {
    throw new Error('SECRET-CREDENTIAL')
  })
  vi.stubGlobal('fetch', send)
  expect(await invocation({} as Env, 'worker.fetch', async () => 42)).toBe(42)
  expect(send).not.toHaveBeenCalled()
  const env = {
    TELEMETRY_ENABLED: '1',
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://failure.invalid',
    OTEL_EXPORTER_OTLP_HEADERS: '{}',
    OTEL_TRACES_SAMPLER_ARG: '0',
  } as Env
  expect(await invocation(env, 'worker.fetch', async () => 42, { force: true })).toBe(42)
  expect(send).toHaveBeenCalledTimes(1)
  expect(parseTraceparent('00-' + '0'.repeat(32) + '-' + '1'.repeat(16) + '-01')).toBeUndefined()
  expect(parseTraceparent('00-' + '1'.repeat(32) + '-' + '2'.repeat(16) + '-00')?.sampled).toBe(
    false
  )
})
