import { classifyNativeFailure } from './diagnostics'

/** Public links are deliberate presentation fields, never credential-bearing request URLs. */
export function publicLink(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 4096 || /[\r\n\u0000]/.test(value)) return
  if (value.startsWith('/') && !value.startsWith('//')) {
    const url = new URL(value, 'https://status.invalid')
    return url.pathname + publicQuery(url) + url.hash
  }
  try {
    const url = new URL(value)
    if (!['http:', 'https:', 'mailto:'].includes(url.protocol) || url.username || url.password)
      return
    url.search = publicQuery(url)
    return url.toString()
  } catch {
    return
  }
}
function publicQuery(url: URL): string {
  const search = new URLSearchParams(url.search)
  for (const key of Array.from(search.keys()))
    if (/token|password|secret|authorization|api.?key|signature|credential/i.test(key))
      search.delete(key)
  return search.size ? '?' + search.toString() : ''
}
export function publicFailure(stage: string, code: string, message = '') {
  return classifyNativeFailure(`[${stage}/${code}] ${message}`)
}
