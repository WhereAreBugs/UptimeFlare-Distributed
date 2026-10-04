import { describe, expect, it } from 'vitest'
import { publicLink, publicFailure } from '../src/privacy'
import { buildPublicDashboard } from '../src/public-dashboard'

describe('public privacy contract', () => {
  it('never projects private request settings or credentials', () => {
    const marker = 'PRIVATE_SENTINEL_秘密'
    const snapshot = buildPublicDashboard(
      {
        monitors: [
          {
            id: 'test',
            name: 'Public',
            method: 'GET',
            target: 'https://example.org/?token=' + marker,
            headers: { Authorization: marker },
            body: marker,
            checkProxy: marker,
            notificationTemplateId: marker,
          },
        ],
        notificationTemplates: [
          {
            id: marker,
            name: marker,
            type: 'webhook',
            webhook: { url: marker, payloadType: 'json', payload: marker },
          },
        ],
      },
      1700000000
    )
    expect(JSON.stringify(snapshot)).not.toContain(marker)
    expect(snapshot.monitors[0].target).toBe('')
  })
  it('strips sensitive query fields and rejects userinfo', () => {
    expect(publicLink('https://user:secret@example.org')).toBeUndefined()
    expect(publicLink('/path?token=SECRET&mode=normal')).toBe('/path?mode=normal')
    expect(publicLink('javascript:alert(1)')).toBeUndefined()
  })
  it('replaces arbitrary remote details with bounded failure descriptions', () => {
    expect(
      JSON.stringify(publicFailure('http', 'unknown', 'SECRET https://example.org?token=SECRET'))
    ).not.toContain('SECRET')
  })
})
