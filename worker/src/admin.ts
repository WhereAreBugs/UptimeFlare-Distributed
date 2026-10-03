import type { MonitorTarget, WorkerConfig } from '../../types/config'
import type { ProbeDefinition } from '../../types/probes'
import type { ProbeEnv } from './probes'
import { getSettings, type EditableSettings } from './settings'
import { CLOUDFLARE_PROBE_ID } from './probe-labels'

export interface AdminEnv extends ProbeEnv {
  ADMIN_PASSWORD?: string
  ADMIN_SESSION_SECRET?: string
}
class AdminInputError extends Error {}
const COOKIE = '__Host-uptime-admin'
const SESSION_SECONDS = 8 * 60 * 60
const MAX_BODY = 64 * 1024
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/
const encoder = new TextEncoder()
const json = (value: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...extra,
    },
  })
const cookie = (value: string, age: number) =>
  `${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${age}`
function equal(a: string, b: string) {
  let diff = a.length ^ b.length
  for (let i = 0; i < Math.max(a.length, b.length); i++)
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0)
  return diff === 0
}
async function digest(value: string) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
async function signature(payload: string, secret: string) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(payload))))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}
async function authenticated(request: Request, env: AdminEnv) {
  const header = request.headers.get('Cookie') ?? ''
  if (header.length > 8192) return false
  const token = header
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1)
  if (!token || !/^\d{10}\.[a-f0-9]{32}\.[a-f0-9]{64}$/.test(token)) return false
  const [expires, nonce, supplied] = token.split('.')
  const now = Math.floor(Date.now() / 1000)
  if (Number(expires) <= now || Number(expires) > now + SESSION_SECONDS) return false
  // Password rotation invalidates all existing sessions too.
  return equal(
    supplied,
    await signature(`${expires}.${nonce}`, `${env.ADMIN_SESSION_SECRET}:${env.ADMIN_PASSWORD}`)
  )
}
async function readJSON(request: Request) {
  if ((request.headers.get('Content-Type') ?? '').split(';')[0].trim() !== 'application/json')
    throw new AdminInputError('请求必须使用 application/json')
  if (!request.body) throw new AdminInputError('请求正文为空')
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > MAX_BODY) throw new AdminInputError('配置不得超过 64 KiB')
      chunks.push(value)
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
  const data = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    data.set(chunk, offset)
    offset += chunk.byteLength
  }
  try {
    const value = JSON.parse(new TextDecoder().decode(data))
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new AdminInputError('JSON 应为对象')
    return value
  } catch {
    throw new AdminInputError('JSON 格式无效')
  }
}
function text(value: unknown, max: number, required = false): value is string {
  return (
    typeof value === 'string' &&
    (!required || value.trim().length > 0) &&
    encoder.encode(value).length <= max &&
    !/[\r\n\u0000]/.test(value)
  )
}

/** Strict allowlist: configuration never accepts executable callbacks or secret bindings. */
export function validateSettings(value: any, registered: Set<string>): EditableSettings {
  if (
    !value ||
    !Array.isArray(value.monitors) ||
    value.monitors.length > 100 ||
    !Array.isArray(value.probes) ||
    value.probes.length > 33 ||
    value.probes.filter((probe: any) => probe?.id !== CLOUDFLARE_PROBE_ID).length > 32
  )
    throw new AdminInputError('最多 100 个目标、32 个独立探针及 1 个 Cloudflare 探针')
  if (
    !Number.isInteger(value.probeStaleAfterSeconds) ||
    value.probeStaleAfterSeconds < 300 ||
    value.probeStaleAfterSeconds > 86400
  )
    throw new AdminInputError('探针过期时间应为 300–86400 秒')
  const ids = new Set<string>()
  const probes: ProbeDefinition[] = value.probes.map((probe: any) => {
    if (
      !probe ||
      typeof probe.id !== 'string' ||
      !ID.test(probe.id) ||
      ids.has(probe.id) ||
      (!registered.has(probe.id) && probe.id !== CLOUDFLARE_PROBE_ID)
    )
      throw new AdminInputError('探针 ID 必须唯一；独立探针需要配置令牌，cloudflare 为内置探针')
    ids.add(probe.id)
    if (probe.name !== undefined && !text(probe.name, 200))
      throw new AdminInputError('探针名称过长或无效')
    if (probe.location !== undefined && !text(probe.location, 200))
      throw new AdminInputError('探针地区过长或无效')
    return {
      id: probe.id,
      ...(probe.name !== undefined && { name: probe.name }),
      ...(probe.location !== undefined && { location: probe.location }),
    }
  })
  if (!ids.has(CLOUDFLARE_PROBE_ID)) probes.push({ id: CLOUDFLARE_PROBE_ID })
  const monitorIds = new Set<string>()
  let assignments = 0
  const monitors: MonitorTarget[] = value.monitors.map((monitor: any) => {
    if (
      !monitor ||
      typeof monitor.id !== 'string' ||
      !ID.test(monitor.id) ||
      monitorIds.has(monitor.id)
    )
      throw new AdminInputError('目标 ID 必须唯一，仅使用字母、数字、点、下划线或连字符')
    monitorIds.add(monitor.id)
    if (!text(monitor.name, 200, true) || !text(monitor.target, 2048, true))
      throw new AdminInputError('目标名称和地址不能为空或过长')
    if (
      !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TCP_PING'].includes(
        monitor.method
      )
    )
      throw new AdminInputError('检测方法无效')
    if (monitor.method === 'TCP_PING') {
      if (
        !/^(?:\[[0-9a-fA-F:]+\]|[^\s:/?#]+):\d{1,5}$/.test(monitor.target) ||
        Number(monitor.target.slice(monitor.target.lastIndexOf(':') + 1)) < 1 ||
        Number(monitor.target.slice(monitor.target.lastIndexOf(':') + 1)) > 65535
      )
        throw new AdminInputError('TCP 地址应为 host:port，IPv6 使用 [地址]:port')
    } else {
      let url: URL
      try {
        url = new URL(monitor.target)
      } catch {
        throw new AdminInputError('HTTP 地址无效')
      }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
        throw new AdminInputError('HTTP 地址只支持 http/https，鉴权请使用请求头')
    }
    if (
      !Array.isArray(monitor.probes) ||
      !monitor.probes.length ||
      new Set(monitor.probes).size !== monitor.probes.length ||
      monitor.probes.some((id: string) => !ids.has(id) && id !== CLOUDFLARE_PROBE_ID)
    )
      throw new AdminInputError('每个目标至少分配一个已注册探针')
    assignments += monitor.probes.length
    const result: MonitorTarget = {
      id: monitor.id,
      name: monitor.name,
      method: monitor.method,
      target: monitor.target,
      probes: [...monitor.probes],
    }
    if (monitor.timeout !== undefined) {
      if (!Number.isInteger(monitor.timeout) || monitor.timeout < 1 || monitor.timeout > 120000)
        throw new AdminInputError('超时应为 1–120000 毫秒')
      result.timeout = monitor.timeout
    }
    if (monitor.expectedCodes !== undefined) {
      if (
        !Array.isArray(monitor.expectedCodes) ||
        !monitor.expectedCodes.length ||
        monitor.expectedCodes.length > 20 ||
        monitor.expectedCodes.some(
          (code: number) => !Number.isInteger(code) || code < 100 || code > 599
        )
      )
        throw new AdminInputError('HTTP 状态码无效')
      result.expectedCodes = [...monitor.expectedCodes]
    }
    for (const field of [
      'responseKeyword',
      'responseForbiddenKeyword',
      'tooltip',
      'statusPageLink',
    ] as const) {
      if (monitor[field] !== undefined) {
        if (!text(monitor[field], field.startsWith('response') ? 4096 : 2048))
          throw new AdminInputError('关键词或显示字段过长或无效')
        if (field === 'statusPageLink' && monitor[field]) {
          let url: URL
          try {
            url = new URL(monitor[field])
          } catch {
            throw new AdminInputError('显示链接无效')
          }
          if (!['http:', 'https:'].includes(url.protocol))
            throw new AdminInputError('显示链接只支持 http/https')
        }
        result[field] = monitor[field]
      }
    }
    if (monitor.body !== undefined) {
      if (typeof monitor.body !== 'string' || encoder.encode(monitor.body).length > 16384)
        throw new AdminInputError('请求体最多 16 KiB')
      result.body = monitor.body
    }
    if (monitor.headers !== undefined) {
      if (
        !monitor.headers ||
        typeof monitor.headers !== 'object' ||
        Array.isArray(monitor.headers) ||
        Object.keys(monitor.headers).length > 32
      )
        throw new AdminInputError('请求头无效或超过 32 个')
      const headers: Record<string, string> = {}
      for (const [key, item] of Object.entries(monitor.headers)) {
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || !text(item, 4096))
          throw new AdminInputError('请求头名称或内容无效')
        headers[key] = item
      }
      result.headers = headers
    }
    if (monitor.hideLatencyChart !== undefined) {
      if (typeof monitor.hideLatencyChart !== 'boolean') throw new AdminInputError('图表开关无效')
      result.hideLatencyChart = monitor.hideLatencyChart
    }
    return result
  })
  if (assignments > 64) throw new AdminInputError('目标与探针分配组合最多 64 个')
  return { monitors, probes, probeStaleAfterSeconds: value.probeStaleAfterSeconds }
}

export async function handleAdminRequest(
  request: Request,
  env: AdminEnv,
  fallback: WorkerConfig
): Promise<Response> {
  if (
    !env.ADMIN_PASSWORD ||
    env.ADMIN_PASSWORD.length < 16 ||
    !env.ADMIN_SESSION_SECRET ||
    env.ADMIN_SESSION_SECRET.length < 32
  )
    return json({ error: '管理登录尚未配置' }, 503)
  const path = new URL(request.url).pathname
  const allowed = path === '/api/admin/config' ? ['GET', 'PUT'] : ['POST']
  if (!allowed.includes(request.method))
    return json({ error: 'Method not allowed' }, 405, { Allow: allowed.join(', ') })
  // All writes, including login, require same-origin browser requests; no CORS exposure.
  if (request.method !== 'GET' && request.headers.get('Origin') !== new URL(request.url).origin)
    return json({ error: '跨站请求被拒绝' }, 403)
  try {
    if (path === '/api/admin/login') {
      const address = request.headers.get('CF-Connecting-IP') ?? 'local'
      const window = Math.floor(Date.now() / 1000 / 900)
      const addressHash = await digest(address)
      const attempt = await env.UPTIMEFLARE_D1.prepare(
        'INSERT INTO admin_login_attempts (address, window, attempts) VALUES (?, ?, 1) ON CONFLICT(address) DO UPDATE SET window = excluded.window, attempts = CASE WHEN admin_login_attempts.window = excluded.window THEN admin_login_attempts.attempts + 1 ELSE 1 END RETURNING attempts'
      )
        .bind(addressHash, window)
        .first<{ attempts: number }>()
      if (!attempt || attempt.attempts > 10)
        return json({ error: '登录尝试过多，请稍后重试' }, 429, { 'Retry-After': '900' })
      const data = await readJSON(request)
      if (
        typeof data.password !== 'string' ||
        data.password.length > 1024 ||
        !equal(await digest(data.password), await digest(env.ADMIN_PASSWORD))
      )
        return json({ error: '密码错误' }, 401)
      const expires = Math.floor(Date.now() / 1000) + SESSION_SECONDS
      const nonce = crypto.randomUUID().replaceAll('-', '')
      const payload = `${expires}.${nonce}`
      const token = `${payload}.${await signature(
        payload,
        `${env.ADMIN_SESSION_SECRET}:${env.ADMIN_PASSWORD}`
      )}`
      return json({ ok: true }, 200, { 'Set-Cookie': cookie(token, SESSION_SECONDS) })
    }
    if (!(await authenticated(request, env))) return json({ error: '请先登录' }, 401)
    if (path === '/api/admin/logout')
      return json({ ok: true }, 200, { 'Set-Cookie': cookie('', 0) })
    if (path !== '/api/admin/config') return json({ error: 'Not found' }, 404)
    if (request.method === 'GET') return json(await getSettings(env, fallback))
    const data = await readJSON(request)
    if (!Number.isSafeInteger(data.revision) || data.revision < 0)
      return json({ error: '配置版本无效' }, 400)
    const registered = new Set(Object.keys(JSON.parse(env.PROBE_TOKENS ?? '{}')))
    const settings = validateSettings(data, registered)
    const result = await env.UPTIMEFLARE_D1.prepare(
      'INSERT INTO admin_config (id, revision, value, updated_at) SELECT 1, ?, ?, ? WHERE ? = 0 OR EXISTS (SELECT 1 FROM admin_config WHERE id = 1) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, value = excluded.value, updated_at = excluded.updated_at WHERE admin_config.revision = excluded.revision - 1'
    )
      .bind(
        data.revision + 1,
        JSON.stringify(settings),
        Math.floor(Date.now() / 1000),
        data.revision
      )
      .run()
    if (!result.meta.changes) return json({ error: '配置已被其他窗口修改，请重新加载后保存' }, 409)
    return json(await getSettings(env, fallback))
  } catch (error) {
    // Never echo D1 errors, SQL, configured targets, passwords or request contents.
    if (error instanceof AdminInputError) return json({ error: error.message }, 400)
    return json({ error: '配置服务暂时不可用' }, 503)
  }
}
