import sanitizeHtml from 'sanitize-html'
import type { MaintenanceConfig, Notification, PageConfig } from '../../types/config'
import { normalizeInternalIds } from '../../util/internal-id'
import { maintenanceTime } from '../../util/maintenance'

const enc = new TextEncoder()
const plain = (value: unknown, max: number, required = false): value is string =>
  typeof value === 'string' &&
  enc.encode(value).length <= max &&
  !/[\r\n\u0000]/.test(value) &&
  (!required || !!value.trim())
export class PresentationInputError extends Error {}
function invalid(message: string): never {
  throw new PresentationInputError(message)
}
function url(value: unknown, relative = false): string {
  if (!plain(value, 2048, true)) invalid('链接或图标地址无效')
  if (relative && value.startsWith('/') && !value.startsWith('//')) return value
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return invalid('链接或图标地址无效')
  }
  if (
    !['https:', 'http:', ...(relative ? ['mailto:'] : [])].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password
  )
    invalid('链接只支持 http/https、站内路径或 mailto')
  return value
}
export function validTimeZone(value: unknown): value is string {
  if (!plain(value, 100, true)) return false
  try {
    new Intl.DateTimeFormat('en', { timeZone: value }).format()
    return true
  } catch {
    return false
  }
}
export function validatePage(value: any, ids: Set<string>): PageConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('页面设置无效')
  const result: PageConfig = {}
  if (value.title !== undefined) {
    if (!plain(value.title, 200, true)) invalid('页面标题不能为空或过长')
    result.title = value.title
  }
  for (const field of ['logo', 'favicon'] as const)
    if (value[field]) result[field] = url(value[field], true)
  if (value.links !== undefined) {
    if (!Array.isArray(value.links) || value.links.length > 20) invalid('导航链接最多 20 个')
    result.links = value.links.map((link: any) => {
      if (
        !link ||
        !plain(link.label, 100, true) ||
        (link.highlight !== undefined && typeof link.highlight !== 'boolean')
      )
        invalid('导航链接名称或选项无效')
      return {
        label: link.label,
        link: url(link.link, true),
        ...(link.highlight !== undefined && { highlight: link.highlight }),
      }
    })
  }
  if (value.group !== undefined) {
    if (
      !value.group ||
      typeof value.group !== 'object' ||
      Array.isArray(value.group) ||
      Object.keys(value.group).length > 50
    )
      invalid('分组最多 50 个')
    const names = new Set<string>(),
      used = new Set<string>()
    const groups: [string, string[]][] = []
    for (const [rawName, members] of Object.entries(value.group)) {
      if (
        !plain(rawName, 200, true) ||
        ['__proto__', 'constructor', 'prototype'].includes(rawName) ||
        !Array.isArray(members) ||
        members.length > 500 ||
        members.some((id) => typeof id !== 'string')
      )
        invalid('分组名称或成员无效')
      let name = rawName.trim(),
        suffix = 2
      while (names.has(name)) name = `${rawName.trim()}（${suffix++}）`
      names.add(name)
      const targets = Array.from(new Set<string>(members as string[])).filter(
        (id) => ids.has(id) && !used.has(id)
      )
      targets.forEach((id) => used.add(id))
      groups.push([name, targets])
    }
    result.group = Object.fromEntries(groups)
  }
  if (value.maintenances !== undefined) {
    if (!value.maintenances || !plain(value.maintenances.upcomingColor, 40))
      invalid('维护提示颜色无效')
    result.maintenances = { upcomingColor: value.maintenances.upcomingColor }
  }
  if (value.customFooter !== undefined) {
    if (typeof value.customFooter !== 'string' || enc.encode(value.customFooter).length > 16384)
      invalid('页脚最多 16 KiB')
    result.customFooter = sanitizeHtml(value.customFooter, {
      allowedTags: [
        'p',
        'div',
        'span',
        'a',
        'strong',
        'b',
        'em',
        'i',
        'small',
        'br',
        'ul',
        'ol',
        'li',
        'code',
      ],
      allowedAttributes: { a: ['href', 'title', 'target', 'rel'], '*': ['style'] },
      allowedSchemes: ['https', 'http', 'mailto'],
      allowProtocolRelative: false,
      allowedStyles: {
        '*': {
          'text-align': [/^(left|right|center)$/],
          color: [/^#[a-f0-9]{3,8}$/i],
          'font-size': [/^\d{1,2}(px|rem|em)$/],
          'margin-top': [/^\d{1,2}(px|rem|em)$/],
        },
      },
      transformTags: {
        a: (tagName, attribs) => ({ tagName, attribs: { ...attribs, rel: 'noopener noreferrer' } }),
      },
    })
  }
  return result
}
export function validateMaintenances(value: any, ids: Set<string>): MaintenanceConfig[] {
  if (!Array.isArray(value) || value.length > 50) invalid('维护计划最多 50 个')
  return normalizeInternalIds(value, 'maintenance').flatMap((plan: any) => {
    const start = maintenanceTime(plan.start),
      end = plan.end === undefined || plan.end === '' ? undefined : maintenanceTime(plan.end)
    if (
      !Number.isFinite(start) ||
      start < 0 ||
      start > 4102444800 ||
      (end !== undefined && (!Number.isFinite(end) || end <= start || end > 4102444800))
    )
      invalid('维护开始和结束时间无效')
    if (
      typeof plan.body !== 'string' ||
      !plan.body.trim() ||
      enc.encode(plan.body).length > 4096 ||
      /\u0000/.test(plan.body)
    )
      invalid('维护说明不能为空或超过 4 KiB')
    if (plan.title !== undefined && !plain(plan.title, 200)) invalid('维护标题过长')
    if (plan.color !== undefined && !plain(plan.color, 40)) invalid('维护颜色无效')
    if (
      plan.monitors !== undefined &&
      (!Array.isArray(plan.monitors) || plan.monitors.some((id: any) => typeof id !== 'string'))
    )
      invalid('维护目标无效')
    if (
      plan.repeat &&
      (!['daily', 'weekly', 'monthly'].includes(plan.repeat.frequency) ||
        !validTimeZone(plan.repeat.timeZone) ||
        end === undefined ||
        end - start > 7 * 86400)
    )
      invalid('重复维护需要有效时区及不超过 7 天的结束时间')
    const members =
      plan.monitors === undefined
        ? undefined
        : Array.from(new Set<string>(plan.monitors)).filter((id) => ids.has(id))
    if (plan.monitors?.length && !members?.length) return []
    return [
      {
        id: plan.id,
        body: plan.body,
        start: new Date(start * 1000).toISOString(),
        ...(end !== undefined && { end: new Date(end * 1000).toISOString() }),
        ...(plan.title !== undefined && { title: plan.title }),
        ...(plan.color !== undefined && { color: plan.color }),
        ...(members !== undefined && { monitors: members }),
        ...(plan.repeat && {
          repeat: { frequency: plan.repeat.frequency, timeZone: plan.repeat.timeZone },
        }),
      },
    ]
  })
}
export function validateNotificationDefaults(value: any, ids: Set<string>): Notification {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('通知默认设置无效')
  const result: Notification = {}
  if (value.timeZone !== undefined) {
    if (!validTimeZone(value.timeZone)) invalid('通知时区无效')
    result.timeZone = value.timeZone
  }
  if (value.gracePeriod !== undefined) {
    if (!Number.isInteger(value.gracePeriod) || value.gracePeriod < 0 || value.gracePeriod > 1440)
      invalid('通知宽限期应为 0–1440 分钟')
    result.gracePeriod = value.gracePeriod
  }
  if (value.skipNotificationIds !== undefined) {
    if (
      !Array.isArray(value.skipNotificationIds) ||
      value.skipNotificationIds.some((id: any) => typeof id !== 'string')
    )
      invalid('通知排除目标无效')
    result.skipNotificationIds = Array.from(new Set<string>(value.skipNotificationIds)).filter(
      (id) => ids.has(id)
    )
  }
  if (value.skipErrorChangeNotification !== undefined) {
    if (typeof value.skipErrorChangeNotification !== 'boolean') invalid('失败原因变化通知开关无效')
    result.skipErrorChangeNotification = value.skipErrorChangeNotification
  }
  return result
}
