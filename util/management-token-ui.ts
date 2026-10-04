import type { PageConfigGroup } from '../types/config'
import type { ManagementGroup, ManagementTokenEntry } from '../types/management'

/** Only saved groups can retain an identity through an explicit rename. */
export function savedGroupRenames(
  groups: PageConfigGroup,
  savedIds: Record<string, string>,
  drafts: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(drafts).flatMap(([oldName, value]) => {
      const newName = value.trim()
      return Object.hasOwn(groups, oldName) &&
        Object.hasOwn(savedIds, oldName) &&
        newName &&
        newName !== oldName
        ? [[oldName, newName]]
        : []
    })
  )
}

/** IDs accompany final names, while a removed draft identity stays removed. */
export function renamedSavedGroupIds(
  finalGroups: PageConfigGroup,
  savedIds: Record<string, string>,
  renames: Record<string, string>
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(savedIds).flatMap(([oldName, id]) => {
      const name = Object.hasOwn(renames, oldName) ? renames[oldName] : oldName
      return Object.hasOwn(finalGroups, name) ? [[name, id]] : []
    })
  )
}

/** Browser-local input is converted to an explicit Unix instant before sending. */
export function managementTokenExpiry(value: string, now = Date.now()): number | null {
  if (!value) return null
  const time = new Date(value).getTime()
  if (!Number.isFinite(time) || time <= now) throw new Error('到期时间必须晚于当前时间')
  return Math.floor(time / 1000)
}

export function managementTokenStatus(
  token: Pick<ManagementTokenEntry, 'revokedAt' | 'expiresAt'>,
  now = Math.floor(Date.now() / 1000)
): 'active' | 'revoked' | 'expired' {
  if (token.revokedAt !== null) return 'revoked'
  return token.expiresAt !== null && token.expiresAt <= now ? 'expired' : 'active'
}

/** Resolve live names by identity; deleted groups must never bind to a recreated name. */
export function managementTokenGroups(
  token: Pick<ManagementTokenEntry, 'groupIds'>,
  groups: ManagementGroup[]
): { names: string[]; deleted: number } {
  const names = new Map(groups.map((group) => [group.id, group.name]))
  const resolved = token.groupIds.flatMap((id) => (names.has(id) ? [names.get(id)!] : []))
  return { names: resolved, deleted: token.groupIds.length - resolved.length }
}
