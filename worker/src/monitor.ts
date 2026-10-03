import { DEFAULT_MONITOR_TIMEOUT_MS } from '../../util/monitor-settings'
import { Env } from '.'
import { MonitorTarget } from '../../types/config'
import { withTimeout, fetchTimeout } from './util'
import {
  classifyNativeFailure,
  formatNativeDiagnostic,
  parseNativeTcpTarget,
  type NativeCheckStatus,
} from './diagnostics'

/** Bound keyword responses and include body reads in the configured check deadline. */
async function readBoundedBody(response: Response, deadline: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let bytes = 0
  try {
    while (true) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('[body/timeout] HTTP response body timed out')
      let part: ReadableStreamReadResult<Uint8Array>
      try {
        part = await withTimeout(remaining, reader.read())
      } catch (error) {
        if (Date.now() >= deadline) throw new Error('[body/timeout] HTTP response body timed out')
        throw error
      }
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > 1024 * 1024) throw new Error('[body/too_large] HTTP response body exceeds 1 MiB')
      chunks.push(decoder.decode(part.value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return chunks.join('')
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

function isIpAddress(hostname: string): boolean {
  // `URL.hostname` strips brackets for IPv6, so a `:` reliably indicates an IPv6 literal here.
  if (hostname.includes(':')) return true

  const parts = hostname.split('.')
  if (parts.length !== 4) return false

  return parts.every((part) => {
    if (!/^\d{1,3}$/.test(part)) return false
    const value = Number(part)
    return value >= 0 && value <= 255
  })
}

function getDomainOnlyIpVersionOption(hostname: string, gpUrl: URL): { ipVersion?: number } {
  // Globalping only allows `measurementOptions.ipVersion` when `target` is a domain (it controls DNS resolution).
  if (isIpAddress(hostname)) return {}

  // Keep the original behavior for domain targets.
  return { ipVersion: Number(gpUrl.searchParams.get('ipVersion') || 4) }
}

async function httpResponseBasicCheck(
  monitor: MonitorTarget,
  code: number,
  bodyReader: () => Promise<string>
): Promise<string | null> {
  if (monitor.expectedCodes) {
    if (!monitor.expectedCodes.includes(code)) {
      return `Expected codes: ${JSON.stringify(monitor.expectedCodes)}, Got: ${code}`
    }
  } else {
    if (code < 200 || code > 299) {
      return `Expected codes: 2xx, Got: ${code}`
    }
  }

  if (monitor.responseKeyword || monitor.responseForbiddenKeyword) {
    // Only read response body if we have a keyword to check
    let responseBody: string
    try {
      responseBody = await bodyReader()
    } catch (error) {
      return formatNativeDiagnostic(classifyNativeFailure(error, 'body'))
    }

    // MUST contain responseKeyword
    if (monitor.responseKeyword && !responseBody.includes(monitor.responseKeyword)) {
      console.log(`${monitor.name} failed the expected response keyword check`)
      return "HTTP response doesn't contain the configured keyword"
    }

    // MUST NOT contain responseForbiddenKeyword
    if (
      monitor.responseForbiddenKeyword &&
      responseBody.includes(monitor.responseForbiddenKeyword)
    ) {
      console.log(`${monitor.name} failed the forbidden response keyword check`)
      return 'HTTP response contains the configured forbidden keyword'
    }
  }

  return null
}

export async function getStatusWithGlobalPing(
  monitor: MonitorTarget
): Promise<{ location: string; status: NativeCheckStatus }> {
  let failureContext: 'configuration' | 'proxy' = 'configuration'
  // TODO: should throw when there's error with globalping API
  try {
    if (monitor.checkProxy === undefined) {
      throw "empty check proxy for globalping, shouldn't call this method"
    }

    const gpUrl = new URL(monitor.checkProxy)
    if (gpUrl.protocol !== 'globalping:') {
      throw 'incorrect check proxy protocol for globalping, got: ' + gpUrl.protocol
    }

    const token = gpUrl.hostname
    let globalPingRequest = {}

    if (monitor.method === 'TCP_PING') {
      const targetUrl = parseNativeTcpTarget(monitor.target)
      const ipVersionOption = getDomainOnlyIpVersionOption(targetUrl.hostname, gpUrl)
      globalPingRequest = {
        type: 'ping',
        target: targetUrl.hostname,
        locations:
          gpUrl.searchParams.get('magic') !== null
            ? [
                {
                  magic: gpUrl.searchParams.get('magic'),
                },
              ]
            : undefined,
        measurementOptions: {
          port: targetUrl.port,
          packets: 1,
          protocol: 'tcp', // TODO: icmp?
          ...ipVersionOption,
        },
      }
    } else {
      const targetUrl = new URL(monitor.target)
      const ipVersionOption = getDomainOnlyIpVersionOption(targetUrl.hostname, gpUrl)
      if (monitor.body !== undefined) {
        throw 'custom body not supported'
      }
      if (monitor.method && !['GET', 'HEAD', 'OPTIONS'].includes(monitor.method.toUpperCase())) {
        throw 'only GET, HEAD, OPTIONS methods are supported'
      }
      globalPingRequest = {
        type: 'http',
        target: targetUrl.hostname,
        locations:
          gpUrl.searchParams.get('magic') !== null
            ? [
                {
                  magic: gpUrl.searchParams.get('magic'),
                },
              ]
            : undefined,
        measurementOptions: {
          request: {
            method: monitor.method,
            path: targetUrl.pathname,
            query: targetUrl.search === '' ? undefined : targetUrl.search,
            headers: Object.fromEntries(
              Object.entries(monitor.headers ?? {}).map(([key, value]) => [key, String(value)])
            ), // TODO: host header?
          },
          port:
            targetUrl.port === ''
              ? targetUrl.protocol === 'http:'
                ? 80
                : 443
              : Number(targetUrl.port),
          protocol: targetUrl.protocol.replace(':', ''),
          ...ipVersionOption,
        },
      }
    }

    const startTime = Date.now()
    console.log('Requesting a Globalping measurement')
    failureContext = 'proxy'
    const measurement = await fetchTimeout('https://api.globalping.io/v1/measurements', 5000, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + token,
      },
      body: JSON.stringify(globalPingRequest),
    })
    const measurementResponse = (await measurement.json()) as any

    if (measurement.status !== 202) {
      throw measurementResponse.error.message
    }

    const measurementId = measurementResponse.id
    console.log(
      `Measurement created successfully, id: ${measurementId}, time elapsed: ${
        Date.now() - startTime
      }ms`
    )

    const pollStart = Date.now()
    let measurementResult: any
    while (true) {
      if (Date.now() - pollStart > (monitor.timeout ?? DEFAULT_MONITOR_TIMEOUT_MS) + 2000) {
        // 2s extra buffer
        throw 'api polling timeout'
      }

      measurementResult = (await (
        await fetchTimeout(`https://api.globalping.io/v1/measurements/${measurementId}`, 5000)
      ).json()) as any
      if (measurementResult.status !== 'in-progress') {
        break
      }

      await new Promise((resolve) => setTimeout(resolve, 1000))
    }

    console.log(`Measurement ${measurementId} finished, time elapsed: ${Date.now() - pollStart}ms`)

    if (
      measurementResult.status !== 'finished' ||
      measurementResult.results[0].result.status !== 'finished'
    ) {
      console.log(
        `measurement failed with status: ${measurementResult.status}, result status: ${measurementResult.results[0].result.status}`
      )
      // Truncate raw output to avoid huge error messages
      throw `status [${measurementResult.status}|${
        measurementResult.results[0].result.status
      }]: ${measurementResult.results?.[0].result?.rawOutput?.slice(0, 64)}`
    }

    const country = measurementResult.results[0].probe.country
    const city = measurementResult.results[0].probe.city

    if (monitor.method === 'TCP_PING') {
      const time = Math.round(measurementResult.results[0].result.stats.avg)
      return {
        location: country + '/' + city,
        status: {
          ping: time,
          up: true,
          err: '',
        },
      }
    } else {
      const time = measurementResult.results[0].result.timings.total
      const code = measurementResult.results[0].result.statusCode
      const body = measurementResult.results[0].result.rawBody

      let err = await httpResponseBasicCheck(monitor, code, () => body)
      if (err !== null) {
        console.log(`${monitor.name} didn't pass response check: ${err}`)
      }

      if (
        monitor.target.toLowerCase().startsWith('https') &&
        !measurementResult.results[0].result.tls.authorized
      ) {
        console.log(`${monitor.name} failed TLS certificate validation`)
        err = '[tls/certificate] TLS certificate validation failed'
      }

      return {
        location: country + '/' + city,
        status: {
          ping: time,
          up: err === null,
          err: err ?? '',
        },
      }
    }
  } catch (e: any) {
    const diagnostic = classifyNativeFailure(e, failureContext)
    console.log(`Globalping ${monitor.name} failed: ${formatNativeDiagnostic(diagnostic)}`)
    return {
      location: 'ERROR',
      status: {
        ping: diagnostic.code === 'timeout' ? monitor.timeout ?? DEFAULT_MONITOR_TIMEOUT_MS : 0,
        up: false,
        err: formatNativeDiagnostic(diagnostic),
        stage: diagnostic.stage,
        code: diagnostic.code,
      },
    }
  }
}

export async function getStatus(monitor: MonitorTarget): Promise<NativeCheckStatus> {
  let status: NativeCheckStatus = {
    ping: 0,
    up: false,
    err: 'Unknown',
  }

  const startTime = Date.now()

  if (monitor.method === 'TCP_PING') {
    // TCP port endpoint monitor
    let socket: { close: () => Promise<void> } | undefined
    try {
      const parsed = parseNativeTcpTarget(monitor.target)
      const connect = await import(/* webpackIgnore: true */ 'cloudflare:sockets').then(
        (sockets) => sockets.connect
      )
      const connected = connect(parsed)
      socket = connected

      // Now we have an `opened` promise!
      await withTimeout(monitor.timeout ?? DEFAULT_MONITOR_TIMEOUT_MS, connected.opened)

      console.log(`${monitor.name} connected successfully`)

      status.ping = Date.now() - startTime
      status.up = true
      status.err = ''
    } catch (e: Error | any) {
      const diagnostic = classifyNativeFailure(e, 'tcp')
      console.log(`${monitor.name} failed: ${formatNativeDiagnostic(diagnostic)}`)
      if (diagnostic.code === 'timeout') {
        status.ping = monitor.timeout ?? DEFAULT_MONITOR_TIMEOUT_MS
      }
      status.up = false
      status.err = formatNativeDiagnostic(diagnostic)
      status.stage = diagnostic.stage
      status.code = diagnostic.code
    } finally {
      // Cleanup failures do not establish that a successfully opened connection was unreachable.
      try {
        await socket?.close()
      } catch {
        /* Best effort socket cleanup. */
      }
    }
  } else {
    // HTTP endpoint monitor
    try {
      const parsed = new URL(monitor.target)
      if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname)
        throw new Error('Unsupported URL protocol')
      let headers = new Headers(monitor.headers as any)
      if (!headers.has('user-agent')) {
        headers.set('user-agent', 'UptimeFlare/1.0 (+https://github.com/lyc8503/UptimeFlare)')
      }

      const response = await fetchTimeout(
        monitor.target,
        monitor.timeout ?? DEFAULT_MONITOR_TIMEOUT_MS,
        {
          method: monitor.method,
          headers: headers,
          body: monitor.body,
          redirect: 'manual',
          cf: {
            cacheTtlByStatus: {
              '100-599': -1, // Don't cache any status code, from https://developers.cloudflare.com/workers/runtime-apis/request/#requestinitcfproperties
            },
          },
        }
      )

      console.log(`${monitor.name} responded with ${response.status}`)
      status.ping = Date.now() - startTime

      const err = await httpResponseBasicCheck(monitor, response.status, () =>
        readBoundedBody(response, startTime + (monitor.timeout ?? DEFAULT_MONITOR_TIMEOUT_MS))
      )
      try {
        await response.body?.cancel()
      } catch (e) {} // Always try to cancel body, see issue #166

      if (err !== null) {
        console.log(`${monitor.name} didn't pass response check: ${err}`)
      }
      status.up = err === null
      status.err = err ?? ''
    } catch (e: any) {
      const diagnostic = classifyNativeFailure(e, 'http')
      console.log(`${monitor.name} failed: ${formatNativeDiagnostic(diagnostic)}`)
      if (diagnostic.code === 'timeout') {
        status.ping = monitor.timeout ?? DEFAULT_MONITOR_TIMEOUT_MS
      }
      status.up = false
      status.err = formatNativeDiagnostic(diagnostic)
      status.stage = diagnostic.stage
      status.code = diagnostic.code
    }
  }

  return status
}

export async function doMonitor(monitor: MonitorTarget, defaultLocation: string, env: Env) {
  let checkLocation = defaultLocation
  let status

  if (monitor.checkProxy) {
    // Initiate a check using proxy (Geo-specific monitoring)
    try {
      console.log(`[${monitor.id}] Calling check proxy`)
      let resp
      if (monitor.checkProxy.startsWith('worker://')) {
        const doLoc = monitor.checkProxy.replace('worker://', '')
        const doId = env.REMOTE_CHECKER_DO.idFromName(monitor.id)
        const doStub = env.REMOTE_CHECKER_DO.get(doId, {
          locationHint: doLoc as DurableObjectLocationHint,
        })
        resp = await doStub.getLocationAndStatus(monitor)
        try {
          // Kill the DO instance after use, to avoid extra resource usage
          await doStub.kill()
        } catch (err) {
          // An error here is expected, ignore it
        }
      } else if (monitor.checkProxy.startsWith('globalping://')) {
        resp = await getStatusWithGlobalPing(monitor)
      } else {
        const response = await fetchTimeout(
          monitor.checkProxy,
          monitor.timeout ?? DEFAULT_MONITOR_TIMEOUT_MS,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(monitor),
          }
        )
        if (!response.ok) throw new Error('Check proxy returned an unsuccessful HTTP response')
        resp = await response.json<{ location: string; status: NativeCheckStatus }>()
      }
      if (
        !resp ||
        typeof resp.location !== 'string' ||
        typeof resp.status?.up !== 'boolean' ||
        typeof resp.status.err !== 'string' ||
        !Number.isFinite(resp.status.ping)
      )
        throw new Error('Invalid check proxy response')
      checkLocation = resp.location
      status = resp.status
    } catch (err) {
      console.log(`[${monitor.id}] Check proxy failed`)
      if (monitor.checkProxyFallback) {
        console.log('Falling back to local check...')
        status = await getStatus(monitor)
      } else {
        // TODO: more consistent error handling (throw or return?)
        status = {
          ping: 0,
          up: false,
          err: formatNativeDiagnostic(classifyNativeFailure(err, 'proxy')),
        }
      }
    }
  } else {
    // Initiate a check from the current location
    status = await getStatus(monitor)
  }

  if (!status.up) {
    const diagnostic = classifyNativeFailure(
      status.err,
      monitor.method === 'TCP_PING' ? 'tcp' : 'http'
    )
    status = {
      ping: status.ping,
      up: false,
      err: formatNativeDiagnostic(diagnostic),
      stage: diagnostic.stage,
      code: diagnostic.code,
    }
  } else {
    status = { ping: status.ping, up: true, err: '' }
  }

  console.log(
    `[${monitor.id}] Check result from ${checkLocation}: up=${status.up}, ping=${status.ping}, err=${status.err}`
  )

  return {
    location: checkLocation,
    status,
    id: monitor.id,
  }
}
