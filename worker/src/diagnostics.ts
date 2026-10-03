export type NativeFailureStage =
  | 'dns'
  | 'tcp'
  | 'tls'
  | 'http'
  | 'body'
  | 'configuration'
  | 'proxy'
  | 'unknown'
export type NativeDiagnostic = { stage: NativeFailureStage; code: string; message: string }
export type NativeCheckStatus = {
  ping: number
  up: boolean
  err: string
  stage?: NativeFailureStage
  code?: string
}
type Context = 'http' | 'tcp' | 'body' | 'configuration' | 'proxy'

const stages = new Set(['dns', 'tcp', 'tls', 'http', 'body', 'configuration', 'proxy', 'unknown'])
const statusMessage = /^Expected codes: (?:\[[\d, ]{1,160}\]|2xx), Got: \d{3}$/

export function parseNativeTcpTarget(target: string): { hostname: string; port: number } {
  // Non-special schemes retain 443, unlike a dummy https URL which silently strips that port.
  const parsed = new URL('tcp://' + target)
  const port = Number(parsed.port)
  if (
    !parsed.hostname ||
    !parsed.port ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    parsed.pathname ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  )
    throw new Error('Invalid target or port')
  return { hostname: parsed.hostname.replace(/^\[|\]$/g, ''), port }
}

/** Stored historical errors without a stage prefix remain explicitly unclassified. */
export function parseNativeDiagnostic(error: string): NativeDiagnostic {
  const match = /^\[([a-z]+)\/([a-z0-9_]{1,64})\] ([\s\S]*)$/.exec(error)
  if (match && stages.has(match[1])) {
    return { stage: match[1] as NativeFailureStage, code: match[2], message: match[3] }
  }
  return { stage: 'unknown', code: 'unknown', message: error }
}

function diagnostic(stage: NativeFailureStage, code: string, message: string): NativeDiagnostic {
  return { stage, code, message }
}

function safeMessage(stage: NativeFailureStage, code: string, original: string): string {
  if (stage === 'http' && code === 'status')
    return statusMessage.test(original) ? original : 'Unexpected HTTP response status'
  if (stage === 'body' && code === 'keyword')
    return original === "HTTP response doesn't contain the configured keyword" ||
      original === 'HTTP response contains the configured forbidden keyword'
      ? original
      : 'HTTP response content failed the configured keyword check'
  if (stage === 'body') {
    if (code === 'timeout') return 'HTTP response body timed out'
    if (code === 'too_large') return 'HTTP response body exceeds the 1 MiB limit'
    return 'Failed while reading the HTTP response body'
  }
  if (stage === 'configuration') return 'Invalid or unsupported monitor configuration'
  if (stage === 'proxy') return 'The check proxy failed to return a usable result'
  if (stage === 'dns')
    return code === 'timeout'
      ? 'DNS resolution timed out'
      : code === 'not_found'
      ? 'DNS name was not found'
      : 'DNS resolution failed'
  if (stage === 'tls')
    return code === 'certificate' ? 'TLS certificate validation failed' : 'TLS handshake failed'
  if (stage === 'tcp')
    return (
      {
        timeout: 'TCP connection timed out',
        refused: 'TCP connection was refused',
        reset: 'TCP connection was reset',
        unreachable: 'Network or host is unreachable',
      }[code] ?? 'TCP connection failed'
    )
  return code === 'timeout'
    ? 'The check timed out; the runtime did not expose the connection stage'
    : 'The check failed; the runtime did not expose a reliable connection stage'
}

/** Only classify errors supported by explicit runtime evidence. Raw details never enter public history. */
export function classifyNativeFailure(error: unknown, context: Context = 'http'): NativeDiagnostic {
  const text =
    error instanceof Error
      ? `${error.name}: ${error.message}`
      : typeof error === 'string'
      ? error
      : ''
  const raw = error instanceof Error ? error.message : text
  const prefixed = parseNativeDiagnostic(raw)
  if (/^\[[a-z]+\/[a-z0-9_]+\] /.test(raw) && stages.has(prefixed.stage)) {
    const allowedCodes: Record<NativeFailureStage, string[]> = {
      dns: ['not_found', 'timeout', 'unknown'],
      tcp: ['timeout', 'refused', 'reset', 'unreachable', 'unknown'],
      tls: ['certificate', 'unknown'],
      http: ['status', 'unknown'],
      body: ['keyword', 'read', 'timeout', 'too_large', 'unknown'],
      configuration: ['invalid_request', 'invalid_target', 'unknown'],
      proxy: ['unknown'],
      unknown: ['timeout', 'unknown'],
    }
    const code = allowedCodes[prefixed.stage].includes(prefixed.code) ? prefixed.code : 'unknown'
    return { ...prefixed, code, message: safeMessage(prefixed.stage, code, prefixed.message) }
  }
  if (context === 'proxy' || /^Globalping error:/i.test(text))
    return diagnostic('proxy', 'unknown', safeMessage('proxy', 'unknown', ''))
  if (
    context === 'configuration' ||
    /invalid (?:url|target|port)|unsupported (?:url|protocol|method)|invalid.*(?:header|method)|GET\/HEAD method cannot have body/i.test(
      text
    )
  )
    return diagnostic(
      'configuration',
      'invalid_request',
      safeMessage('configuration', 'invalid_request', '')
    )
  const plain = text.replace(/^Error: /, '')
  if (statusMessage.test(plain)) return diagnostic('http', 'status', plain)
  if (
    plain === "HTTP response doesn't contain the configured keyword" ||
    plain === 'HTTP response contains the configured forbidden keyword'
  )
    return diagnostic('body', 'keyword', plain)
  if (
    /\b(?:DNS|resolve|resolution)\b[^\n]{0,100}(?:timed? out|timeout)|(?:timed? out|timeout)[^\n]{0,100}\bDNS\b/i.test(
      text
    )
  )
    return diagnostic('dns', 'timeout', safeMessage('dns', 'timeout', ''))
  if (/\b(?:ENOTFOUND|EAI_NONAME|NXDOMAIN)\b|no such host|name or service not known/i.test(text))
    return diagnostic('dns', 'not_found', safeMessage('dns', 'not_found', ''))
  if (/\bDNS\b[^\n]{0,100}(?:fail|error)|\bEAI_AGAIN\b/i.test(text))
    return diagnostic('dns', 'unknown', safeMessage('dns', 'unknown', ''))
  if (
    /\bERR_CERT_[A-Z_]+\b|\bx509:|certificate[^\n]{0,100}(?:expired|not trusted|verify failed|invalid|unknown authority)|self[- ]signed certificate|unable to verify.*certificate/i.test(
      text
    )
  )
    return diagnostic('tls', 'certificate', safeMessage('tls', 'certificate', ''))
  if (
    /\bTLS\b[^\n]{0,100}(?:handshake|alert|protocol)[^\n]{0,100}(?:fail|error)|\bSSL_ERROR_\w+/i.test(
      text
    )
  )
    return diagnostic('tls', 'unknown', safeMessage('tls', 'unknown', ''))
  if (/\bECONNREFUSED\b|connection refused/i.test(text))
    return diagnostic('tcp', 'refused', safeMessage('tcp', 'refused', ''))
  if (/\bECONNRESET\b|connection reset/i.test(text))
    return diagnostic('tcp', 'reset', safeMessage('tcp', 'reset', ''))
  if (/\b(?:EHOSTUNREACH|ENETUNREACH)\b|no route to host|network is unreachable/i.test(text))
    return diagnostic('tcp', 'unreachable', safeMessage('tcp', 'unreachable', ''))
  if (context === 'body') return diagnostic('body', 'read', safeMessage('body', 'read', ''))
  if (/\b(?:AbortError|TimeoutError|ETIMEDOUT)\b|timed? out|timeout/i.test(text)) {
    const stage = context === 'tcp' ? 'tcp' : 'unknown'
    return diagnostic(stage, 'timeout', safeMessage(stage, 'timeout', ''))
  }
  return diagnostic('unknown', 'unknown', safeMessage('unknown', 'unknown', ''))
}

export function formatNativeDiagnostic(value: NativeDiagnostic): string {
  return `[${value.stage}/${value.code}] ${safeMessage(value.stage, value.code, value.message)}`
}
