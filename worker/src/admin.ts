import {
  getMonitorIntervalSeconds,
  MIN_MONITOR_INTERVAL_SECONDS,
  MAX_MONITOR_INTERVAL_SECONDS,
} from '../../util/monitor-settings'
import type { MonitorTarget, NotificationTemplate, WorkerConfig } from '../../types/config'
import { normalizeInternalIds } from '../../util/internal-id'
import type { ProbeDefinition } from '../../types/probes'
import type { ProbeEnv } from './probes'
import { getSettings, type EditableSettings } from './settings'
import { CLOUDFLARE_PROBE_ID } from './probe-labels'
import { validatePage, validateMaintenances, validateNotificationDefaults, PresentationInputError } from './presentation'

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
  const ids = new Set<string>()
  const probes: ProbeDefinition[] = []
  for (const probe of value.probes) {
    if (
      !probe ||
      typeof probe.id !== 'string' ||
      !ID.test(probe.id) ||
      (!registered.has(probe.id) && probe.id !== CLOUDFLARE_PROBE_ID)
    )
      throw new AdminInputError('独立探针需要配置令牌；Cloudflare 为内置探针')
    if (ids.has(probe.id)) continue
    ids.add(probe.id)
    if (probe.name !== undefined && !text(probe.name, 200))
      throw new AdminInputError('探针名称过长或无效')
    if (probe.location !== undefined && !text(probe.location, 200))
      throw new AdminInputError('探针地区过长或无效')
    probes.push({
      id: probe.id,
      ...(probe.name !== undefined && { name: probe.name }),
      ...(probe.location !== undefined && { location: probe.location }),
    })
  }
  if (!ids.has(CLOUDFLARE_PROBE_ID)) probes.push({ id: CLOUDFLARE_PROBE_ID })
  const rawTemplates = value.notificationTemplates ?? []
  if (!Array.isArray(rawTemplates) || rawTemplates.length > 50)
    throw new AdminInputError('通知模板最多 50 个')
  const notificationTemplates: NotificationTemplate[] = normalizeInternalIds(
    rawTemplates,
    'template'
  ).map((template: any) => {
    if (!text(template.name, 200, true) || template.type !== 'webhook')
      throw new AdminInputError('通知模板名称不能为空，类型应为 Webhook')
    const webhook = template.webhook
    if (!webhook || !text(webhook.url, 2048, true))
      throw new AdminInputError('Webhook 地址不能为空或过长')
    let url: URL
    try {
      url = new URL(webhook.url)
    } catch {
      throw new AdminInputError('Webhook 地址无效')
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new AdminInputError('Webhook 地址只支持 http/https，鉴权请使用请求头')
    const method = webhook.method ?? 'POST'
    if (
      !['GET', 'POST', 'PUT', 'PATCH'].includes(method) ||
      !['param', 'json', 'x-www-form-urlencoded'].includes(webhook.payloadType) ||
      (method === 'GET' && webhook.payloadType !== 'param')
    )
      throw new AdminInputError('Webhook 请求方法与参数格式不匹配')
    if (
      !webhook.payload ||
      typeof webhook.payload !== 'object' ||
      Array.isArray(webhook.payload) ||
      encoder.encode(JSON.stringify(webhook.payload)).length > 16384
    )
      throw new AdminInputError('Webhook 正文应为 JSON 对象，最多 16 KiB')
    const pending = [{ value: webhook.payload, depth: 0 }]
    let nodes = 0
    while (pending.length) {
      const entry = pending.pop()!
      if (++nodes > 2048 || entry.depth > 16)
        throw new AdminInputError('Webhook 正文嵌套或字段数量过多')
      if (entry.value && typeof entry.value === 'object') {
        for (const item of Object.values(entry.value))
          pending.push({ value: item, depth: entry.depth + 1 })
      }
    }
    if (
      webhook.payloadType !== 'json' &&
      Object.values(webhook.payload).some((item) => item !== null && typeof item === 'object')
    )
      throw new AdminInputError('查询参数和表单只支持单层字段')
    const headers: Record<string, string> = {}
    if (webhook.headers !== undefined) {
      if (
        !webhook.headers ||
        typeof webhook.headers !== 'object' ||
        Array.isArray(webhook.headers) ||
        Object.keys(webhook.headers).length > 32
      )
        throw new AdminInputError('Webhook 请求头无效或超过 32 个')
      for (const [key, item] of Object.entries(webhook.headers)) {
        if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || !text(item, 4096))
          throw new AdminInputError('Webhook 请求头名称或内容无效')
        headers[key] = item
      }
    }
    const timeout = webhook.timeout ?? 5000
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30000)
      throw new AdminInputError('Webhook 超时应为 1–30000 毫秒')
    return {
      id: template.id,
      name: template.name,
      type: 'webhook',
      webhook: {
        url: webhook.url,
        method,
        payloadType: webhook.payloadType,
        payload: webhook.payload,
        headers,
        timeout,
      },
    }
  })
  const templateIds = new Set(notificationTemplates.map((template) => template.id))
  let assignments = 0
  const monitors: MonitorTarget[] = normalizeInternalIds(value.monitors, 'monitor').map(
    (monitor: any) => {
      if (!text(monitor.name, 200, true) || !text(monitor.target, 2048, true))
        throw new AdminInputError('目标名称和地址不能为空或过长')
      if (
        !['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'TCP_PING', 'SSL_CERT', 'ICMP_PING'].includes(
          monitor.method
        )
      )
        throw new AdminInputError('检测方法无效')
      if (monitor.method === 'ICMP_PING') {
        if (!/^(?:[a-zA-Z0-9_.-]+|[a-fA-F0-9:]+)$/.test(monitor.target) || monitor.target.includes('://') || /\s/.test(monitor.target))
          throw new AdminInputError('ICMP 目标应为域名或 IP，不包含协议和端口')
        if (monitor.target.includes(':')) {
          try { new URL(`http://[${monitor.target}]/`) } catch { throw new AdminInputError('ICMP IPv6 地址无效') }
        }
      } else if (monitor.method === 'TCP_PING') {
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
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (monitor.method === 'SSL_CERT' && url.protocol !== 'https:'))
          throw new AdminInputError('HTTP 地址只支持 http/https，鉴权请使用请求头')
      }
      if (
        !Array.isArray(monitor.probes) ||
        !monitor.probes.length ||
        monitor.probes.some((id: string) => !ids.has(id) && id !== CLOUDFLARE_PROBE_ID)
      )
        throw new AdminInputError('每个目标至少分配一个已注册探针')
      const assigned = Array.from(new Set<string>(monitor.probes))
      assignments += assigned.length
      const result: MonitorTarget = {
        id: monitor.id,
        name: monitor.name,
        method: monitor.method,
        target: monitor.target,
        probes: assigned,
      }
      if (monitor.notificationTemplateId) {
        if (!templateIds.has(monitor.notificationTemplateId))
          throw new AdminInputError('请选择已存在的通知模板')
        result.notificationTemplateId = monitor.notificationTemplateId
      }
      const intervalSeconds = getMonitorIntervalSeconds(monitor)
      if (
        (monitor.intervalSeconds !== undefined && !Number.isInteger(monitor.intervalSeconds)) ||
        !Number.isInteger(intervalSeconds) ||
        intervalSeconds < MIN_MONITOR_INTERVAL_SECONDS ||
        intervalSeconds > MAX_MONITOR_INTERVAL_SECONDS
      )
        throw new AdminInputError('检测周期应为 60–86400 秒')
      result.intervalSeconds = intervalSeconds
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
      if (monitor.certificateExpiryDays !== undefined) {
        if (!Number.isInteger(monitor.certificateExpiryDays) || monitor.certificateExpiryDays < 0 || monitor.certificateExpiryDays > 365)
          throw new AdminInputError('证书到期阈值应为 0–365 天')
        result.certificateExpiryDays = monitor.certificateExpiryDays
      }
      if (monitor.notificationGracePeriodSeconds !== undefined) {
        if (!Number.isInteger(monitor.notificationGracePeriodSeconds) || monitor.notificationGracePeriodSeconds < 0 || monitor.notificationGracePeriodSeconds > 86400)
          throw new AdminInputError('目标通知宽限期应为 0–86400 秒')
        result.notificationGracePeriodSeconds = monitor.notificationGracePeriodSeconds
      }
      for (const field of ['icmpProxyURL', 'checkProxy'] as const) {
        if (monitor[field] !== undefined && monitor[field] !== '') {
          let url: URL
          try { url = new URL(monitor[field]) } catch { throw new AdminInputError('探测代理地址无效') }
          if (url.username || url.password || !['http:', 'https:', ...(field === 'checkProxy' ? ['worker:', 'globalping:'] : [])].includes(url.protocol))
            throw new AdminInputError('探测代理地址协议或鉴权方式无效')
          if (url.protocol === 'worker:' && (!['wnam','enam','sam','weur','eeur','apac','apac-ne','apac-se','oc','afr','me'].includes(url.hostname) || url.search || url.pathname))
            throw new AdminInputError('Cloudflare 地区代码无效')
          if (['worker:', 'globalping:'].includes(url.protocol) && assigned.some(id => id !== CLOUDFLARE_PROBE_ID))
            throw new AdminInputError('worker/globalping 地区代理仅适用于 Cloudflare 探针；Go 探针可使用 HTTP 代理')
          if (monitor.method === 'SSL_CERT' && ['worker:', 'globalping:'].includes(url.protocol))
            throw new AdminInputError('Cloudflare 证书到期检查需要 HTTP 探测代理或改为独立 Go 探针')
          if (url.protocol === 'globalping:' && !['TCP_PING','ICMP_PING'].includes(monitor.method) && (!['GET','HEAD','OPTIONS'].includes(monitor.method) || monitor.body !== undefined))
            throw new AdminInputError('Globalping HTTP 仅支持 GET/HEAD/OPTIONS，且不支持请求体')
          result[field] = monitor[field]
        }
      }
      if (monitor.checkProxyHeaders !== undefined) {
        if (!monitor.checkProxyHeaders || typeof monitor.checkProxyHeaders !== 'object' || Array.isArray(monitor.checkProxyHeaders) || Object.keys(monitor.checkProxyHeaders).length > 32)
          throw new AdminInputError('代理请求头无效')
        result.checkProxyHeaders = {}
        for (const [key, item] of Object.entries(monitor.checkProxyHeaders)) {
          if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) || !text(item,4096)) throw new AdminInputError('代理请求头无效')
          result.checkProxyHeaders[key] = item
        }
      }
      if (monitor.checkProxyFallback !== undefined) {
        if (typeof monitor.checkProxyFallback !== 'boolean') throw new AdminInputError('代理回退开关无效')
        result.checkProxyFallback = monitor.checkProxyFallback
      }
      if (assigned.includes(CLOUDFLARE_PROBE_ID) && monitor.method === 'SSL_CERT' && !result.checkProxy)
        throw new AdminInputError('Cloudflare 证书到期检查需要配置 HTTP 探测代理；独立 Go 探针可直接检查')
      if (assigned.includes(CLOUDFLARE_PROBE_ID) && monitor.method === 'ICMP_PING' && !result.icmpProxyURL && (!result.checkProxy || result.checkProxy.startsWith('worker://')))
        throw new AdminInputError('Cloudflare ICMP 检查需要配置 ICMP 或 Globalping 探测代理')
      return result
    }
  )
  if (assignments > 64) throw new AdminInputError('目标与探针分配组合最多 64 个')
  return {
    monitors,
    probes,
    notificationTemplates,
    ...(value.page !== undefined && { page: validatePage(value.page, new Set(monitors.map(m => m.id))) }),
    ...(value.maintenances !== undefined && { maintenances: validateMaintenances(value.maintenances, new Set(monitors.map(m => m.id))) }),
    ...(value.notification !== undefined && { notification: validateNotificationDefaults(value.notification, new Set(monitors.map(m => m.id))) }),
  }
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
    if (error instanceof AdminInputError || error instanceof PresentationInputError) return json({ error: error.message }, 400)
    return json({ error: '配置服务暂时不可用' }, 503)
  }
}
