import { describe, expect, test } from 'vitest'
import {
  classifyNativeFailure,
  formatNativeDiagnostic,
  parseNativeDiagnostic,
  parseNativeTcpTarget,
} from '../src/diagnostics'

describe('native check diagnostics', () => {
  test('TCP target parsing keeps explicit default HTTPS ports and validates malformed targets', () => {
    expect(parseNativeTcpTarget('example.test:443')).toEqual({
      hostname: 'example.test',
      port: 443,
    })
    expect(parseNativeTcpTarget('[::1]:443')).toEqual({ hostname: '::1', port: 443 })
    for (const target of ['host', 'host:0', 'host:65536', 'host:80/path', 'user:pass@host:80'])
      expect(() => parseNativeTcpTarget(target)).toThrow()
  })
  test.each([
    ['Expected codes: 2xx, Got: 503', 'http', 'status'],
    ['Expected codes: [200,204], Got: 404', 'http', 'status'],
    ["HTTP response doesn't contain the configured keyword", 'body', 'keyword'],
    ['HTTP response contains the configured forbidden keyword', 'body', 'keyword'],
    ['getaddrinfo ENOTFOUND private.example', 'dns', 'not_found'],
    ['DNS resolution timed out for private.example', 'dns', 'timeout'],
    ['certificate has expired for private.example', 'tls', 'certificate'],
    ['Error: TLS certificate not trusted', 'tls', 'certificate'],
    ['connect ECONNREFUSED 192.0.2.1', 'tcp', 'refused'],
    ['connection reset by peer', 'tcp', 'reset'],
    ['network is unreachable', 'tcp', 'unreachable'],
    [
      'TypeError: Invalid URL https://secret.example?token=secret',
      'configuration',
      'invalid_request',
    ],
  ])('classifies explicit evidence: %s', (message, stage, code) => {
    const result = classifyNativeFailure(message)
    expect(result.stage).toBe(stage)
    expect(result.code).toBe(code)
  })

  test('a generic fetch error or timeout does not invent DNS/TCP/TLS evidence', () => {
    expect(classifyNativeFailure(new TypeError('fetch failed'))).toMatchObject({
      stage: 'unknown',
      code: 'unknown',
    })
    expect(
      classifyNativeFailure(new DOMException('The operation was aborted', 'AbortError'))
    ).toMatchObject({ stage: 'unknown', code: 'timeout' })
    expect(classifyNativeFailure('Timeout after 10000ms')).toMatchObject({
      stage: 'unknown',
      code: 'timeout',
    })
    expect(classifyNativeFailure('ETIMEDOUT during fetch')).toMatchObject({
      stage: 'unknown',
      code: 'timeout',
    })
    expect(classifyNativeFailure('Promise timed out after 10000ms', 'tcp')).toMatchObject({
      stage: 'tcp',
      code: 'timeout',
    })
  })

  test('a proxy transport error describes the proxy boundary', () => {
    expect(classifyNativeFailure('connect ECONNREFUSED secret-proxy', 'proxy')).toMatchObject({
      stage: 'proxy',
      code: 'unknown',
    })
    expect(classifyNativeFailure('Globalping error: DNS timeout')).toMatchObject({
      stage: 'proxy',
      code: 'unknown',
    })
  })

  test('public messages never repeat sensitive raw request details', () => {
    for (const message of [
      'Fetch failed for https://user:pass@private.example?token=abc Authorization: Bearer abc',
      'certificate expired for https://user:pass@private.example?token=abc',
      '[tcp/abc] Authorization: Bearer abc',
    ]) {
      const formatted = formatNativeDiagnostic(classifyNativeFailure(message))
      for (const forbidden of ['private.example', 'user', 'pass', 'Bearer', 'abc', 'Authorization'])
        expect(formatted).not.toContain(forbidden)
    }
  })

  test('prefixes appear once and stable safe HTTP details remain available', () => {
    const formatted = formatNativeDiagnostic(
      classifyNativeFailure('Expected codes: [200,204], Got: 503')
    )
    expect(formatted).toBe('[http/status] Expected codes: [200,204], Got: 503')
    expect(formatNativeDiagnostic(classifyNativeFailure(formatted))).toBe(formatted)
    expect(formatNativeDiagnostic(classifyNativeFailure(new Error(formatted)))).toBe(formatted)
    expect(parseNativeDiagnostic(formatted)).toEqual({
      stage: 'http',
      code: 'status',
      message: 'Expected codes: [200,204], Got: 503',
    })
    expect(parseNativeDiagnostic('A historical error')).toEqual({
      stage: 'unknown',
      code: 'unknown',
      message: 'A historical error',
    })
  })
})
