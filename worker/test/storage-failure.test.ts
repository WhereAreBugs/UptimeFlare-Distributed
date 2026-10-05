import { describe, expect, it } from 'vitest'
import { storageFailureReason } from '../src/storage-failure'

describe('private storage diagnostics', () => {
  it('recognizes direct and wrapped D1 quota failures without exposing their text', () => {
    const cause = new Error("D1_ERROR: Your account has exceeded D1's maximum daily row read limit")
    expect(storageFailureReason(cause)).toBe('d1_read_quota')
    expect(storageFailureReason(Object.assign(new Error('query failed'), { cause }))).toBe('d1_read_quota')
  })
  it('retains only a whitelisted reason when errors contain private values', () => {
    const secret = 'PRIVATE_DIAGNOSTIC_FIXTURE https://private.invalid/?token=secret'
    for (const error of [new Error(secret), new TypeError(secret), new SyntaxError(secret), secret, { message: secret }]) {
      expect(storageFailureReason(error)).not.toContain(secret)
      expect(storageFailureReason(error)).not.toContain('token')
    }
    expect(storageFailureReason(new Error(secret))).toBe('unclassified')
    expect(storageFailureReason(new Error('D1_ERROR: no such table: private_table'))).toBe('d1_schema_missing')
  })
})
