const validId = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/

export function createInternalId(
  prefix: string,
  used: Set<string>,
  uuid: () => string = () => crypto.randomUUID()
): string {
  const base = `${prefix}-${uuid()}`
  let id = base
  let suffix = 0
  while (used.has(id)) id = `${base}-${++suffix}`
  used.add(id)
  return id
}

// Preserve existing identities and history; allocate only for missing or repeated identities.
export function normalizeInternalIds<T extends { id?: unknown }>(items: T[], prefix: string) {
  const reserved = new Set(
    items.flatMap((item) =>
      typeof item?.id === 'string' && validId.test(item.id) ? [item.id] : []
    )
  )
  const seen = new Set<string>()
  return items.map((item) => {
    const id =
      typeof item?.id === 'string' && validId.test(item.id) && !seen.has(item.id)
        ? item.id
        : createInternalId(prefix, reserved)
    seen.add(id)
    return { ...item, id }
  })
}
