/** Whitelisted operational reasons; never emit SQL, URLs, or original error text. */
export function storageFailureReason(error: unknown): string {
  let value: unknown = error
  for (let depth = 0; depth < 3 && value instanceof Error; depth++) {
    const message = value.message.toLowerCase()
    if (message.includes('d1') && /exceed|quota/.test(message) && /daily|read/.test(message))
      return 'd1_read_quota'
    if (message.includes('no such table') || message.includes('no such column'))
      return 'd1_schema_missing'
    if (message.includes('too many probe definitions')) return 'probe_capacity'
    if (message.includes('group initialization')) return 'group_initialization'
    if (message.includes('database is locked')) return 'd1_busy'
    value = (value as Error & { cause?: unknown }).cause
  }
  if (error instanceof SyntaxError) return 'invalid_json'
  if (error instanceof TypeError) return 'runtime_type_error'
  return 'unclassified'
}
