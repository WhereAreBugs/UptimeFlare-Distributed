import { describe, expect, test } from 'vitest'
import {
  formatMaintenanceDateTime,
  parseMaintenanceDateTime,
  validMaintenanceTimeZone,
} from '../../util/maintenance-form'

describe('maintenance editor absolute times and explicit local zones', () => {
  test('converts local maintenance inputs without relying on the browser zone', () => {
    expect(parseMaintenanceDateTime('2026-10-04T09:30', 'Asia/Singapore')).toBe(
      '2026-10-04T01:30:00.000Z'
    )
    expect(parseMaintenanceDateTime('2026-10-04T09:30', 'UTC')).toBe('2026-10-04T09:30:00.000Z')
    expect(formatMaintenanceDateTime('2026-10-04T01:30:00.000Z', 'Asia/Singapore')).toBe(
      '2026-10-04T09:30'
    )
    expect(formatMaintenanceDateTime('2026-10-04T09:30:00+08:00', 'UTC')).toBe('2026-10-04T01:30')
  })

  test('supports persisted epoch seconds, epoch milliseconds, and optional empty ends', () => {
    const instant = Date.parse('2026-10-04T01:30:00Z')
    expect(formatMaintenanceDateTime(instant / 1000, 'UTC')).toBe('2026-10-04T01:30')
    expect(formatMaintenanceDateTime(instant, 'UTC')).toBe('2026-10-04T01:30')
    expect(formatMaintenanceDateTime(undefined, 'UTC')).toBe('')
    expect(formatMaintenanceDateTime('', 'UTC')).toBe('')
  })

  test('keeps wall-clock inputs stable around DST changes and rejects nonexistent times', () => {
    for (const local of ['2026-03-07T02:30', '2026-03-09T02:30', '2026-11-01T01:30']) {
      const stored = parseMaintenanceDateTime(local, 'America/New_York')
      expect(stored).not.toBeNull()
      expect(formatMaintenanceDateTime(stored!, 'America/New_York')).toBe(local)
    }
    expect(parseMaintenanceDateTime('2026-03-08T02:30', 'America/New_York')).toBeNull()
    expect(parseMaintenanceDateTime('2026-03-29T02:30', 'Europe/Berlin')).toBeNull()
    expect(parseMaintenanceDateTime('2026-03-29T03:30', 'Europe/Berlin')).toBe(
      '2026-03-29T01:30:00.000Z'
    )
  })

  test('rejects invalid zones, calendar dates, and partial drafts without crashing rendering', () => {
    expect(validMaintenanceTimeZone('Asia/Singapore')).toBe(true)
    expect(validMaintenanceTimeZone('')).toBe(false)
    expect(validMaintenanceTimeZone('not/a-zone')).toBe(false)
    expect(parseMaintenanceDateTime('2026-02-30T09:30', 'UTC')).toBeNull()
    expect(parseMaintenanceDateTime('2026-10-04T25:00', 'UTC')).toBeNull()
    expect(parseMaintenanceDateTime('2026-10', 'UTC')).toBeNull()
    expect(parseMaintenanceDateTime('2026-10-04T09:30', 'not/a-zone')).toBeNull()
    expect(formatMaintenanceDateTime('invalid', 'UTC')).toBe('')
    expect(formatMaintenanceDateTime('2026-10-04T01:30:00Z', 'not/a-zone')).toBe('')
    expect(formatMaintenanceDateTime('2026-03-08T02:30', 'America/New_York')).toBe(
      '2026-03-08T02:30'
    )
  })
})
