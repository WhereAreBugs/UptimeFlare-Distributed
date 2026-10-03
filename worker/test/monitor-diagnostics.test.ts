import { afterEach, describe, expect, test, vi } from 'vitest'
import type { MonitorTarget } from '../../types/config'
import { doMonitor } from '../src/monitor'

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }))
vi.mock('../src/util', async (original) => ({
  fetchTimeout: fetchMock,
  withTimeout: (await original<typeof import('../src/util')>()).withTimeout,
}))

const monitor: MonitorTarget = {
  id: 'host',
  name: 'Host',
  method: 'GET',
  target: 'https://example.test',
  timeout: 1000,
}
afterEach(() => {
  fetchMock.mockReset()
  vi.restoreAllMocks()
})

describe('native monitor incident diagnostics', () => {
  test('HTTP status and content checks produce one stable stage prefix', async () => {
    fetchMock.mockResolvedValueOnce(new Response('failed', { status: 503 }))
    let result = await doMonitor(monitor, 'SIN', {} as never)
    expect(result.status).toMatchObject({
      up: false,
      stage: 'http',
      code: 'status',
      err: '[http/status] Expected codes: 2xx, Got: 503',
    })
    fetchMock.mockResolvedValueOnce(new Response('content that does not match'))
    result = await doMonitor(
      { ...monitor, responseKeyword: 'PRIVATE_REQUIRED_CONTENT' },
      'SIN',
      {} as never
    )
    expect(result.status).toMatchObject({ up: false, stage: 'body', code: 'keyword' })
    expect(result.status.err).toBe(
      "[body/keyword] HTTP response doesn't contain the configured keyword"
    )
    expect(result.status.err).not.toContain('PRIVATE_REQUIRED_CONTENT')
  })

  test('fetch timeouts keep their phase unknown and do not expose target data', async () => {
    fetchMock.mockRejectedValueOnce(
      new DOMException('https://secret.example?token=abc', 'AbortError')
    )
    const result = await doMonitor(monitor, 'SIN', {} as never)
    expect(result.status).toMatchObject({
      up: false,
      stage: 'unknown',
      code: 'timeout',
      ping: 1000,
    })
    expect(result.status.err).not.toContain('secret.example')
    expect(result.status.err).not.toContain('abc')
  })

  test('body reads are distinct from connection establishment', async () => {
    fetchMock.mockResolvedValueOnce({
      status: 200,
      text: async () => {
        throw new Error('stream closed https://secret.example')
      },
      body: { cancel: async () => {} },
    })
    const result = await doMonitor({ ...monitor, responseKeyword: 'expected' }, 'SIN', {} as never)
    expect(result.status).toMatchObject({
      up: false,
      stage: 'body',
      code: 'read',
      err: '[body/read] Failed while reading the HTTP response body',
    })
  })

  test('malformed HTTP and TCP targets fail in configuration before network calls', async () => {
    for (const configured of [
      { ...monitor, target: 'not a URL' },
      { ...monitor, method: 'TCP_PING', target: 'host-without-port' },
    ]) {
      const result = await doMonitor(configured, 'SIN', {} as never)
      expect(result.status).toMatchObject({
        up: false,
        stage: 'configuration',
        code: 'invalid_request',
      })
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('keyword scanning bounds body size and releases the response stream', async () => {
    const cancel = vi.fn()
    fetchMock.mockResolvedValueOnce(
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new Uint8Array(256 * 1024))
          },
          cancel,
        })
      )
    )
    const result = await doMonitor({ ...monitor, responseKeyword: 'expected' }, 'SIN', {} as never)
    expect(result.status).toMatchObject({ up: false, stage: 'body', code: 'too_large' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  test('a stalled body respects the overall timeout and retains body attribution', async () => {
    const cancel = vi.fn()
    fetchMock.mockResolvedValueOnce(new Response(new ReadableStream({ cancel })))
    const result = await doMonitor(
      { ...monitor, timeout: 50, responseKeyword: 'expected' },
      'SIN',
      {} as never
    )
    expect(result.status).toMatchObject({ up: false, stage: 'body', code: 'timeout' })
    expect(cancel).toHaveBeenCalledOnce()
  })

  test('failed proxy transport is classified separately and fallback retains target diagnostics', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED private-proxy?token=abc'))
    let result = await doMonitor(
      { ...monitor, checkProxy: 'https://proxy.test' },
      'SIN',
      {} as never
    )
    expect(result.status).toMatchObject({
      up: false,
      stage: 'proxy',
      code: 'unknown',
      err: '[proxy/unknown] The check proxy failed to return a usable result',
    })
    fetchMock
      .mockRejectedValueOnce(new Error('Proxy failed'))
      .mockResolvedValueOnce(new Response('bad', { status: 503 }))
    result = await doMonitor(
      { ...monitor, checkProxy: 'https://proxy.test', checkProxyFallback: true },
      'SIN',
      {} as never
    )
    expect(result.status).toMatchObject({ stage: 'http', code: 'status' })
  })
})
