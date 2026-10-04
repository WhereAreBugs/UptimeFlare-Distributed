import type { PageConfig, WorkerConfig } from '../../types/config'
import type { ProbeEnv } from './probes'
import { pageConfig } from '../../uptime.config'

export const GROUP_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/
const owns = (value: object, key: string) => Object.prototype.hasOwnProperty.call(value, key)
export class GroupInputError extends Error {}

/** Private identity metadata is projected only for groups that still exist. */
export function projectGroupIds(
  page: PageConfig | undefined,
  supplied: unknown
): Record<string, string> {
  const source =
    supplied && typeof supplied === 'object' && !Array.isArray(supplied)
      ? (supplied as Record<string, unknown>)
      : {}
  const used = new Set<string>()
  return Object.fromEntries(
    Object.keys(page?.group ?? {}).flatMap((name) => {
      const id = source[name]
      if (typeof id !== 'string' || !GROUP_ID.test(id) || used.has(id)) return []
      used.add(id)
      return [[name, id]]
    })
  )
}

/** Initialize private identities without modifying targets, credentials, or the settings revision. */
export async function ensureGroupIds(env: ProbeEnv, fallback: WorkerConfig): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = await env.UPTIMEFLARE_D1.prepare(
      'SELECT revision,value FROM admin_config WHERE id=1'
    ).first<{ revision: number; value: string }>()
    const value = row
      ? JSON.parse(row.value)
      : {
          monitors: fallback.monitors,
          probes: fallback.probes ?? [],
          notificationTemplates: fallback.notificationTemplates ?? [],
          ...(fallback.page && { page: fallback.page }),
          ...(fallback.maintenances && { maintenances: fallback.maintenances }),
          ...(fallback.notification && { notification: fallback.notification }),
        }
    const page = value.page ?? fallback.page ?? pageConfig
    const names = Object.keys(page.group ?? {})
    const ids = projectGroupIds(page, value._groupIds)
    if (row && names.every((name) => ids[name])) return
    names.forEach((name) => {
      if (!ids[name]) ids[name] = crypto.randomUUID()
    })
    const serialized = JSON.stringify({ ...value, _groupIds: ids })
    const statement = row
      ? env.UPTIMEFLARE_D1.prepare(
          'UPDATE admin_config SET value=? WHERE id=1 AND revision=? AND value=?'
        ).bind(serialized, row.revision, row.value)
      : env.UPTIMEFLARE_D1.prepare(
          'INSERT OR IGNORE INTO admin_config(id,revision,value,updated_at) VALUES(1,0,?,?)'
        ).bind(serialized, Math.floor(Date.now() / 1000))
    const result = await statement.run()
    if (!result.success) throw new Error('Group initialization failed')
    if (result.meta.changes) return
  }
  throw new Error('Group initialization conflict')
}

/** A name change must be explicit. Deleted identities can never be supplied back by a client. */
export function updatedGroupIds(
  page: PageConfig | undefined,
  previous: Record<string, string>,
  suppliedRenames: unknown,
  suppliedIds?: unknown
): Record<string, string> {
  const names = new Set(Object.keys(page?.group ?? {}))
  const renamed = new Map<string, string>()
  if (suppliedRenames !== undefined) {
    if (
      !suppliedRenames ||
      typeof suppliedRenames !== 'object' ||
      Array.isArray(suppliedRenames) ||
      Object.keys(suppliedRenames).length > 50
    )
      throw new GroupInputError('分组改名映射无效')
    const oldNames = new Set<string>()
    for (const [oldName, newName] of Object.entries(suppliedRenames)) {
      if (
        !owns(previous, oldName) ||
        typeof newName !== 'string' ||
        newName !== newName.trim() ||
        !names.has(newName) ||
        names.has(oldName) ||
        owns(previous, newName) ||
        renamed.has(newName) ||
        oldNames.has(oldName)
      )
        throw new GroupInputError('分组改名必须保留现有身份且不能覆盖其他分组')
      renamed.set(newName, previous[oldName])
      oldNames.add(oldName)
    }
  }
  let explicit: Record<string, string> | undefined
  if (suppliedIds !== undefined) {
    if (
      !suppliedIds ||
      typeof suppliedIds !== 'object' ||
      Array.isArray(suppliedIds) ||
      Object.keys(suppliedIds).length > 50
    )
      throw new GroupInputError('分组身份映射无效')
    explicit = suppliedIds as Record<string, string>
    const used = new Set<string>()
    for (const [name, id] of Object.entries(explicit)) {
      if (
        !names.has(name) ||
        typeof id !== 'string' ||
        !GROUP_ID.test(id) ||
        used.has(id) ||
        (previous[name] !== id && renamed.get(name) !== id)
      )
        throw new GroupInputError('分组身份不能复用已删除或其他分组的身份')
      used.add(id)
    }
  }
  return Object.fromEntries(
    Array.from(names, (name) => [
      name,
      renamed.get(name) ?? (explicit ? explicit[name] : previous[name]) ?? crypto.randomUUID(),
    ])
  )
}
