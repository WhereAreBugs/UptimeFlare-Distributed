import { getPublicNativeState } from './store'
import type { MonitorTarget, WorkerConfig } from '../../types/config'
import type {
  ManagementPermission,
  ManagementTokenEntry,
  ManagementTokenList,
  ManagementMonitorStatus,
} from '../../types/management'
import type { ProbeEnv } from './probes'
import { ensureGroupIds, GROUP_ID } from './groups'
import { getSettings, type StoredSettings } from './settings'
import { saveConfiguration } from './configuration-write'
import { getMonitorStaleAfterSeconds } from '../../util/monitor-settings'
import {
  expandMaintenances,
  getPresentationSettings,
  maintenanceTime,
} from '../../util/maintenance'
import { CompactedMonitorStateWrapper, getFromStore } from './store'
import { aggregateStatus } from '../../util/probe-status'

const encoder = new TextEncoder()
const MAX_ACTIVE = 100
const MAX_RETAINED = 1000
const TOKEN = /^Bearer (ufm_[a-f0-9]{64})$/
const ACTIVE = 'revoked_at IS NULL AND (expires_at IS NULL OR expires_at>unixepoch())'
type TokenRow = {
  id: string
  name: string
  token_hash: string
  group_ids: string
  permissions: number
  created_at: number
  expires_at: number | null
  revoked_at: number | null
}
class InputError extends Error {}
function json(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...headers,
    },
  })
}
async function digest(value: string) {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))),
    (byte) => byte.toString(16).padStart(2, '0')
  ).join('')
}
async function body(request: Request, empty = false): Promise<Record<string, unknown>> {
  if (!request.body) {
    if (empty) return {}
    throw new InputError('请求正文为空')
  }
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    bytes += value.length
    if (bytes > 8192) {
      await reader.cancel()
      throw new InputError('请求正文超过 8 KiB')
    }
    chunks.push(value)
  }
  // The Pages adapter represents an empty POST as a non-null, zero-byte stream.
  if (empty && !bytes) return {}
  if ((request.headers.get('Content-Type') ?? '').split(';')[0].trim() !== 'application/json')
    throw new InputError('请求必须使用 application/json')
  const buffer = new Uint8Array(bytes)
  let offset = 0
  chunks.forEach((chunk) => {
    buffer.set(chunk, offset)
    offset += chunk.length
  })
  let data: unknown
  try {
    data = JSON.parse(new TextDecoder().decode(buffer))
  } catch {
    throw new InputError('JSON 正文无效')
  }
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new InputError('JSON 正文必须是对象')
  return data as Record<string, unknown>
}
function permissions(mask: number): ManagementPermission[] {
  return [...(mask & 1 ? ['query' as const] : []), ...(mask & 2 ? ['control' as const] : [])]
}
function groups(settings: StoredSettings) {
  const ids = new Set(settings.monitors.map((monitor) => monitor.id))
  return Object.entries(settings.groupIds).map(([name, id]) => ({
    id,
    name,
    members: (settings.page?.group?.[name] ?? []).filter((member) => ids.has(member)),
  }))
}
function entry(row: TokenRow, settings: StoredSettings): ManagementTokenEntry {
  const groupIds: string[] = JSON.parse(row.group_ids)
  const names = new Map(groups(settings).map((group) => [group.id, group.name]))
  return {
    id: row.id,
    name: row.name,
    groupIds,
    groupNames: groupIds.flatMap((id) => (names.has(id) ? [names.get(id)!] : [])),
    permissions: permissions(row.permissions),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  }
}
function tokenCreation(data: Record<string, unknown>, settings: StoredSettings) {
  if (
    Object.keys(data).some((key) => !['name', 'groupIds', 'permissions', 'expiresAt'].includes(key))
  )
    throw new InputError('创建 Token 包含不支持的字段')
  if (
    typeof data.name !== 'string' ||
    !data.name.trim() ||
    encoder.encode(data.name).length > 200 ||
    /[\r\n\u0000]/.test(data.name)
  )
    throw new InputError('Token 名称不能为空或超过 200 字节')
  if (
    !Array.isArray(data.groupIds) ||
    !data.groupIds.length ||
    data.groupIds.length > 50 ||
    data.groupIds.some((id) => typeof id !== 'string' || !GROUP_ID.test(id)) ||
    new Set(data.groupIds).size !== data.groupIds.length
  )
    throw new InputError('请授权 1–50 个有效分组')
  const allowed = new Set(Object.values(settings.groupIds))
  if (data.groupIds.some((id) => !allowed.has(id)))
    throw new InputError('分组已被修改，请刷新后重试')
  const granted = data.permissions ?? ['query', 'control']
  if (
    !Array.isArray(granted) ||
    !granted.length ||
    granted.length > 2 ||
    granted.some((permission) => !['query', 'control'].includes(permission)) ||
    new Set(granted).size !== granted.length
  )
    throw new InputError('Token 权限无效')
  const expires = data.expiresAt ?? null
  if (
    expires !== null &&
    (!Number.isSafeInteger(expires) ||
      (expires as number) <= Math.floor(Date.now() / 1000) ||
      (expires as number) > 4102444800)
  )
    throw new InputError('有效期必须为未来的 Unix 秒时间或 null')
  return {
    name: data.name.trim(),
    groupIds: data.groupIds as string[],
    mask: (granted.includes('query') ? 1 : 0) | (granted.includes('control') ? 2 : 0),
    expiresAt: expires as number | null,
  }
}

/** Called only after the existing administrator cookie and same-origin checks succeed. */
export async function handleAdminTokens(
  request: Request,
  env: ProbeEnv,
  fallback: WorkerConfig
): Promise<Response> {
  try {
    await ensureGroupIds(env, fallback)
    const settings = await getSettings(env, fallback)
    const path = new URL(request.url).pathname
    if (request.method === 'GET' && path === '/api/admin/tokens') {
      const rows = await env.UPTIMEFLARE_D1.prepare(
        'SELECT * FROM management_tokens ORDER BY created_at DESC,id LIMIT 1000'
      ).all<TokenRow>()
      if (!rows.success) throw new Error('Token list failed')
      const value: ManagementTokenList = {
        groups: groups(settings).map((group) => ({
          id: group.id,
          name: group.name,
          targetCount: group.members.length,
        })),
        tokens: rows.results.map((row) => entry(row, settings)),
        configRevision: settings.revision,
      }
      return json(value)
    }
    if (request.method === 'DELETE') {
      const id = path.slice('/api/admin/tokens/'.length)
      const result = await env.UPTIMEFLARE_D1.prepare(
        'UPDATE management_tokens SET revoked_at=COALESCE(revoked_at,unixepoch()) WHERE id=?'
      )
        .bind(id)
        .run()
      if (!result.success) throw new Error('Token revocation failed')
      return result.meta.changes ? json({ ok: true }) : json({ error: 'Token 不存在' }, 404)
    }
    const data = tokenCreation(await body(request), settings)
    const plain = `ufm_${Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, '0')
    ).join('')}`
    const row: TokenRow = {
      id: crypto.randomUUID(),
      name: data.name,
      token_hash: await digest(plain),
      group_ids: JSON.stringify(data.groupIds),
      permissions: data.mask,
      created_at: Math.floor(Date.now() / 1000),
      expires_at: data.expiresAt,
      revoked_at: null,
    }
    const results = await env.UPTIMEFLARE_D1.batch([
      // Retain revoked/expired entries for at most ninety days, with a hard bound on metadata rows.
      env.UPTIMEFLARE_D1.prepare(`DELETE FROM management_tokens WHERE id IN (
        SELECT id FROM management_tokens WHERE NOT (${ACTIVE}) ORDER BY created_at,id
        LIMIT MAX(0,(SELECT COUNT(*) FROM management_tokens)-${MAX_RETAINED - 1}))
        OR (revoked_at IS NOT NULL AND revoked_at<unixepoch()-7776000)
        OR (expires_at IS NOT NULL AND expires_at<unixepoch()-7776000)`),
      env.UPTIMEFLARE_D1.prepare(
        `INSERT INTO management_tokens(id,name,token_hash,group_ids,permissions,created_at,expires_at,revoked_at)
        SELECT ?,?,?,?,?,?,?,NULL WHERE (SELECT COUNT(*) FROM management_tokens WHERE ${ACTIVE})<${MAX_ACTIVE}
        AND (SELECT COUNT(*) FROM management_tokens)<${MAX_RETAINED}
        AND (? IS NULL OR ?>unixepoch())
        AND EXISTS(SELECT 1 FROM admin_config c WHERE c.id=1 AND c.revision=?
          AND NOT EXISTS(SELECT 1 FROM json_each(?) requested WHERE requested.value NOT IN
            (SELECT value FROM json_each(json_extract(c.value,'$._groupIds')))))`
      ).bind(
        row.id,
        row.name,
        row.token_hash,
        row.group_ids,
        row.permissions,
        row.created_at,
        row.expires_at,
        row.expires_at,
        row.expires_at,
        settings.revision,
        row.group_ids
      ),
    ])
    if (results.some((result) => !result.success)) throw new Error('Token creation failed')
    if (!results[1].meta.changes)
      return json({ error: '分组已变化、有效期已过或活跃 Token 已达 100 个，请刷新后重试' }, 409)
    return json({ token: plain, entry: entry(row, settings) }, 201)
  } catch (error) {
    if (error instanceof InputError) return json({ error: error.message }, 400)
    throw error
  }
}

async function authenticate(request: Request, env: ProbeEnv): Promise<TokenRow | null> {
  const supplied = TOKEN.exec(request.headers.get('Authorization') ?? '')?.[1]
  if (!supplied) return null
  return env.UPTIMEFLARE_D1.prepare(
    `SELECT * FROM management_tokens WHERE token_hash=? AND ${ACTIVE}`
  )
    .bind(await digest(supplied))
    .first<TokenRow>()
}
function authorizedGroups(row: TokenRow, settings: StoredSettings) {
  const granted = new Set<string>(JSON.parse(row.group_ids))
  return groups(settings).filter((group) => granted.has(group.id))
}
async function status(
  env: ProbeEnv,
  config: WorkerConfig,
  monitors: MonitorTarget[],
  now: number
): Promise<ManagementMonitorStatus[]> {
  const pairs = JSON.stringify(
    monitors.flatMap(
      (monitor) => monitor.probes?.map((probe) => ({ probe, monitor: monitor.id })) ?? []
    )
  )
  const [latest, native] = await Promise.all([
    env.UPTIMEFLARE_D1.prepare(
      `SELECT probe_id,monitor_id,time,up,latency_ms FROM probe_latest
      WHERE (probe_id,monitor_id) IN (SELECT json_extract(value,'$.probe'),json_extract(value,'$.monitor') FROM json_each(?))`
    )
      .bind(pairs)
      .all<{
        probe_id: string
        monitor_id: string
        time: number
        up: number
        latency_ms: number
      }>(),
    monitors.some((monitor) => !monitor.probes?.length)
      ? getPublicNativeState(env, monitors)
      : Promise.resolve(null),
  ])
  if (!latest.success) throw new Error('Status read failed')
  const latestMap = new Map(
    latest.results.map((row) => [`${row.monitor_id}\0${row.probe_id}`, row])
  )
  const state = new CompactedMonitorStateWrapper(native)
  const maintenance = expandMaintenances(
    getPresentationSettings(config).maintenances,
    now - 1,
    now + 1
  ).filter(
    (plan) =>
      maintenanceTime(plan.start) <= now &&
      (plan.end === undefined || maintenanceTime(plan.end) >= now)
  )
  return monitors.map((monitor) => {
    let current: ManagementMonitorStatus['status'] = 'unknown'
    let time: number | null = null,
      latency: number | null = null
    let up: number | null = null,
      down: number | null = null,
      unknown: number | null = null
    if (monitor.probes?.length) {
      const rows = monitor.probes.map((id) => latestMap.get(`${monitor.id}\0${id}`))
      up = rows.filter(
        (row) => row && row.time >= now - getMonitorStaleAfterSeconds(monitor) && row.up
      ).length
      down = rows.filter(
        (row) => row && row.time >= now - getMonitorStaleAfterSeconds(monitor) && !row.up
      ).length
      unknown = rows.length - up - down
      current = aggregateStatus(up, down, unknown)
      const reported = rows.flatMap((row) => (row ? [row.time] : []))
      time = reported.length ? Math.max(...reported) : null
      const successful = rows.filter(
        (row) => row && row.up && row.time >= now - getMonitorStaleAfterSeconds(monitor)
      )
      latency = successful.length
        ? successful.reduce((sum, row) => sum + row!.latency_ms, 0) / successful.length
        : null
    } else {
      const sample = state.latencyLen(monitor.id) ? state.getLastLatency(monitor.id) : null
      const count = state.incidentLen(monitor.id)
      const incident = count ? state.getIncident(monitor.id, count - 1) : null
      time = sample?.time ?? null
      if (sample && incident && sample.time >= now - getMonitorStaleAfterSeconds(monitor)) {
        current = incident.end === null ? 'down' : 'up'
        latency = current === 'up' ? sample.ping : null
      }
    }
    current = monitor.paused
      ? 'paused'
      : maintenance.some((plan) => !plan.monitors?.length || plan.monitors.includes(monitor.id))
      ? 'maintenance'
      : current
    return {
      id: monitor.id,
      name: monitor.name,
      paused: !!monitor.paused,
      status: current,
      up: current === 'up' ? true : current === 'down' || current === 'degraded' ? false : null,
      latest: time,
      latencyMs: current === 'paused' ? null : latency,
      reachableProbes: monitor.paused ? null : up,
      unreachableProbes: monitor.paused ? null : down,
      unknownProbes: monitor.paused ? null : unknown,
    }
  })
}

/** Exact Bearer-only API. Credentials confer no administrator or probe-ingestion authority. */
export async function handleManagementRequest(
  request: Request,
  env: ProbeEnv,
  fallback: WorkerConfig
): Promise<Response> {
  const url = new URL(request.url)
  const groupStatus = /^\/api\/manage\/groups\/([a-f0-9-]{36})\/status$/.exec(url.pathname)
  const monitorStatus =
    /^\/api\/manage\/monitors\/([a-zA-Z0-9][a-zA-Z0-9_.-]{0,127})\/status$/.exec(url.pathname)
  const control =
    /^\/api\/manage\/(groups|monitors)\/([a-zA-Z0-9][a-zA-Z0-9_.-]{0,127})\/(enable|disable)$/.exec(
      url.pathname
    )
  const inventory = url.pathname === '/api/manage/groups'
  const allStatus = url.pathname === '/api/manage/status'
  if (!inventory && !allStatus && !groupStatus && !monitorStatus && !control)
    return json({ error: 'Not found' }, 404)
  const method = control ? 'POST' : 'GET'
  if (request.method !== method)
    return json({ error: 'Method not allowed' }, 405, { Allow: method })
  if (url.search) return json({ error: '不支持查询参数' }, 400)
  const origin = request.headers.get('Origin')
  if (origin !== null && origin !== url.origin) return json({ error: '跨站请求被拒绝' }, 403)
  try {
    const token = await authenticate(request, env)
    if (!token) return json({ error: 'Token 无效、已撤销或已过期' }, 401)
    if (!inventory && !(token.permissions & (control ? 2 : 1)))
      return json({ error: 'Token 无此权限' }, 403)
    const settings = await getSettings(env, fallback)
    const scopedGroups = authorizedGroups(token, settings)
    const group = groupStatus || (control?.[1] === 'groups' ? control : null)
    const groupId = groupStatus?.[1] ?? (control?.[1] === 'groups' ? control[2] : undefined)
    if (group && !scopedGroups.some((value) => value.id === groupId))
      return json({ error: '目标不在授权范围内' }, 403)
    const memberIds = new Set(
      (groupId ? scopedGroups.filter((value) => value.id === groupId) : scopedGroups).flatMap(
        (value) => value.members
      )
    )
    const monitorId = monitorStatus?.[1] ?? (control?.[1] === 'monitors' ? control[2] : undefined)
    if (monitorId && !memberIds.has(monitorId)) return json({ error: '目标不在授权范围内' }, 403)
    const monitors = settings.monitors.filter(
      (monitor) => memberIds.has(monitor.id) && (!monitorId || monitor.id === monitorId)
    )
    if (control) {
      if (Object.keys(await body(request, true)).length)
        throw new InputError('控制接口不接受配置字段')
      const paused = control[3] === 'disable'
      const raw = await env.UPTIMEFLARE_D1.prepare(
        'SELECT revision,value FROM admin_config WHERE id=1'
      ).first<{ revision: number; value: string }>()
      if (!raw || raw.revision !== settings.revision)
        return json({ error: '配置已变化，请重试' }, 409)
      const value = JSON.parse(raw.value)
      const selected = JSON.stringify(monitors.map((monitor) => monitor.id))
      const requestedGroup = groupId ?? null
      // Membership and revocation are checked against the live rows at the CAS linearization point.
      const guard = `EXISTS(SELECT 1 FROM management_tokens t JOIN admin_config c ON c.id=1
        WHERE t.id=? AND t.token_hash=? AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>unixepoch()) AND (t.permissions&2)=2
        AND (? IS NULL OR ? IN (SELECT value FROM json_each(t.group_ids)))
        AND (? IS NULL OR ? IN (SELECT value FROM json_each(json_extract(c.value,'$._groupIds'))))
        AND NOT EXISTS(SELECT 1 FROM json_each(?) requested WHERE NOT EXISTS(
          SELECT 1 FROM json_each(t.group_ids) granted
          JOIN json_each(json_extract(c.value,'$._groupIds')) identities ON identities.value=granted.value
          JOIN json_each(CASE WHEN json_type(c.value,'$.page') IS NULL THEN json(?) ELSE COALESCE(json_extract(c.value,'$.page.group'),'{}') END) current_groups ON current_groups.key=identities.key
          JOIN json_each(current_groups.value) members ON members.value=requested.value
          WHERE (? IS NULL OR identities.value=?))))`
      const next = {
        ...value,
        monitors: settings.monitors.map((monitor) =>
          memberIds.has(monitor.id) && (!monitorId || monitor.id === monitorId)
            ? { ...monitor, paused }
            : monitor
        ),
      }
      const changed = await saveConfiguration(
        env,
        next,
        settings.revision,
        settings.monitors,
        guard,
        [
          token.id,
          token.token_hash,
          requestedGroup,
          requestedGroup,
          requestedGroup,
          requestedGroup,
          selected,
          JSON.stringify(settings.page?.group ?? {}),
          requestedGroup,
          requestedGroup,
        ]
      )
      if (!changed) {
        if (!(await authenticate(request, env)))
          return json({ error: 'Token 无效、已撤销或已过期' }, 401)
        return json({ error: '配置或授权范围已变化，请重新查询后重试' }, 409)
      }
      return json({
        ok: true,
        paused,
        updated: monitors.length,
        configRevision: settings.revision + 1,
      })
    }
    const result = inventory
      ? {
          groups: scopedGroups.map((value) => ({
            id: value.id,
            name: value.name,
            monitors: value.members.flatMap((id) => {
              const monitor = settings.monitors.find((item) => item.id === id)
              return monitor ? [{ id, name: monitor.name }] : []
            }),
          })),
          permissions: permissions(token.permissions),
          configRevision: settings.revision,
        }
      : await (async () => {
          const states = await status(
            env,
            { ...fallback, ...settings },
            monitors,
            Math.floor(Date.now() / 1000)
          )
          const times = states.flatMap((monitor) =>
            monitor.latest === null ? [] : [monitor.latest]
          )
          return {
            configRevision: settings.revision,
            updatedAt: times.length ? Math.max(...times) : null,
            monitors: states,
          }
        })()
    const stillAuthorized = await env.UPTIMEFLARE_D1.prepare(
      `SELECT 1 FROM management_tokens t JOIN admin_config c ON c.id=1
      WHERE t.id=? AND t.token_hash=? AND t.revoked_at IS NULL AND (t.expires_at IS NULL OR t.expires_at>unixepoch()) AND c.revision=?`
    )
      .bind(token.id, token.token_hash, settings.revision)
      .first()
    if (!stillAuthorized)
      return json(
        { error: 'Token 或配置已变化，请重试' },
        (await authenticate(request, env)) ? 409 : 401
      )
    return json(result)
  } catch (error) {
    if (error instanceof InputError) return json({ error: error.message }, 400)
    return json({ error: '管理接口暂时不可用' }, 503)
  }
}
