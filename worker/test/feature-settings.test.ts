import { describe, it, expect, afterEach, vi } from 'vitest'
import { validateSettings } from '../src/admin'
import { expandMaintenances, isInMaintenance } from '../../util/maintenance'
import { getStatus, doMonitor, getStatusWithGlobalPing } from '../src/monitor'

const base = () => ({
  probes: [{ id: 'a' }],
  monitors: [
    { id: 'web', name: 'Web', method: 'GET', target: 'https://example.test', probes: ['a'] },
  ],
})
const registered = new Set(['a'])
const time = (value: string) => Date.parse(value) / 1000
afterEach(() => vi.unstubAllGlobals())
describe('web-editable upstream features', () => {
  it('keeps name-based groups ordered, deduplicates membership, and removes deleted target references', () => {
    const value = base()
    const settings = validateSettings(
      { ...value, page: { group: { ' Site ': ['web', 'web', 'deleted'], Site: ['web'] } } },
      registered
    )
    expect(settings.page?.group).toEqual({ Site: ['web'], 'Site（2）': [] })
    expect(
      validateSettings(
        {
          ...value,
          maintenances: [
            {
              title: 'Scoped',
              body: 'Work',
              start: 1700000000,
              end: 1700000100,
              monitors: ['deleted'],
            },
          ],
        },
        registered
      ).maintenances
    ).toEqual([])
  })
  it('sanitizes custom HTML without stripping safe formatting or exposing executable page settings', () => {
    const settings = validateSettings(
      {
        ...base(),
        page: {
          title: 'Status',
          customFooter:
            '<script>alert(1)</script><p style="text-align:center;color:#abc" onclick="evil()">Hello <a href="javascript:evil()">bad</a><a href="https://example.test" target="_blank">safe</a></p>',
        },
      },
      registered
    )
    expect(settings.page?.customFooter).toContain('text-align:center')
    expect(settings.page?.customFooter).toContain('rel="noopener noreferrer"')
    expect(settings.page?.customFooter).not.toMatch(/script|onclick|javascript:|alert\(1\)/)
    expect(() =>
      validateSettings({ ...base(), page: { logo: 'javascript:evil()' } }, registered)
    ).toThrow()
    expect(() =>
      validateSettings({ ...base(), notification: { timeZone: 'made-up-zone' } }, registered)
    ).toThrow()
  })
  it('supports direct Go SSL/ICMP, rejects unsupported Cloudflare combinations and isolates proxy credentials', () => {
    const value = base()
    expect(
      validateSettings(
        {
          ...value,
          monitors: [{ ...value.monitors[0], method: 'SSL_CERT', certificateExpiryDays: 0 }],
        },
        registered
      ).monitors[0].certificateExpiryDays
    ).toBe(0)
    expect(
      validateSettings(
        { ...value, monitors: [{ ...value.monitors[0], method: 'ICMP_PING', target: '::1' }] },
        registered
      ).monitors[0].method
    ).toBe('ICMP_PING')
    expect(() =>
      validateSettings(
        {
          ...value,
          monitors: [{ ...value.monitors[0], method: 'SSL_CERT', probes: ['cloudflare'] }],
        },
        registered
      )
    ).toThrow(/代理/)
    expect(() =>
      validateSettings(
        { ...value, monitors: [{ ...value.monitors[0], checkProxy: 'worker://weur' }] },
        registered
      )
    ).toThrow(/Cloudflare/)
    expect(() =>
      validateSettings(
        {
          ...value,
          monitors: [{ ...value.monitors[0], checkProxy: 'https://user:pass@example.test' }],
        },
        registered
      )
    ).toThrow()
    expect(() =>
      validateSettings(
        {
          ...value,
          monitors: [
            {
              ...value.monitors[0],
              method: 'ICMP_PING',
              target: 'example.test',
              probes: ['cloudflare'],
              checkProxy: 'worker://weur',
            },
          ],
        },
        registered
      )
    ).toThrow(/ICMP/)
    expect(() =>
      validateSettings(
        {
          ...value,
          monitors: [
            {
              ...value.monitors[0],
              method: 'POST',
              probes: ['cloudflare'],
              checkProxy: 'globalping://?magic=Tokyo',
            },
          ],
        },
        registered
      )
    ).toThrow(/GET/)
    expect(
      validateSettings(
        {
          ...value,
          monitors: [
            { ...value.monitors[0], probes: ['cloudflare'], checkProxy: 'worker://apac-ne' },
          ],
        },
        registered
      ).monitors[0].checkProxy
    ).toBe('worker://apac-ne')
    expect(
      validateSettings(
        {
          ...value,
          monitors: [
            {
              ...value.monitors[0],
              checkProxy: 'https://proxy.test/v1/check',
              checkProxyHeaders: { Authorization: 'Bearer private' },
            },
          ],
        },
        registered
      ).monitors[0].checkProxyHeaders
    ).toEqual({ Authorization: 'Bearer private' })
  })
  it('expands repeat maintenance in a bounded window, across DST and monthly short dates', () => {
    const plan = {
      body: 'Night work',
      start: '2026-03-07T14:00:00Z',
      end: '2026-03-07T15:00:00Z',
      repeat: { frequency: 'daily' as const, timeZone: 'America/New_York' },
    }
    const expanded = expandMaintenances(
      [plan],
      time('2026-03-07T00:00:00Z'),
      time('2026-03-10T00:00:00Z')
    )
    expect(expanded.map((p) => p.start)).toEqual([
      '2026-03-07T14:00:00.000Z',
      '2026-03-08T13:00:00.000Z',
      '2026-03-09T13:00:00.000Z',
    ])
    const monthly = expandMaintenances(
      [
        {
          ...plan,
          start: '2026-01-31T09:00:00Z',
          end: '2026-01-31T10:00:00Z',
          repeat: { frequency: 'monthly', timeZone: 'UTC' },
        },
      ],
      time('2026-02-01T00:00:00Z'),
      time('2026-04-01T00:00:00Z')
    )
    expect(monthly.map((p) => p.start)).toEqual([
      '2026-02-28T09:00:00.000Z',
      '2026-03-31T09:00:00.000Z',
    ])
    expect(() => expandMaintenances([plan], 0, 200 * 86400)).toThrow(/125/)
    expect(
      isInMaintenance(
        { monitors: [], maintenances: [{ body: 'Global', start: 1700000000, end: 1700000100 }] },
        'any',
        1700000050
      )
    ).toBe(true)
  })
})
describe('Cloudflare proxy checks', () => {
  it('changes Durable Object identity when the region changes and supplies the selected hint', async () => {
    const idFromName = vi.fn((name: string) => name)
    const stub = {
      getLocationAndStatus: vi
        .fn()
        .mockResolvedValue({ location: 'LHR', status: { up: true, ping: 1, err: '' } }),
      kill: vi.fn().mockResolvedValue(undefined),
    }
    const get = vi.fn((id: string, options: unknown) => stub)
    const env = { REMOTE_CHECKER_DO: { idFromName, get } } as any
    await doMonitor({ ...base().monitors[0], checkProxy: 'worker://weur' }, 'SIN', env)
    await doMonitor({ ...base().monitors[0], checkProxy: 'worker://apac' }, 'SIN', env)
    expect(idFromName.mock.calls[0][0]).not.toBe(idFromName.mock.calls[1][0])
    expect(get.mock.calls[0][1]).toEqual({ locationHint: 'weur' })
    expect(get.mock.calls[1][1]).toEqual({ locationHint: 'apac' })
  })
  it('authenticates a generic check proxy without forwarding proxy headers inside target settings', async () => {
    const send = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            location: 'Tokyo',
            status: {
              up: true,
              ping: 4,
              err: '',
              certificate_expires_at: 2000000000,
              certificate_days_remaining: 123,
            },
          })
        )
      )
    vi.stubGlobal('fetch', send)
    const result = await doMonitor(
      {
        ...base().monitors[0],
        method: 'SSL_CERT',
        checkProxy: 'https://proxy.test/v1/check',
        checkProxyHeaders: { Authorization: 'Bearer proxy-secret' },
      },
      'SIN',
      {} as any
    )
    expect(result.status.certificate_expires_at).toBe(2000000000)
    expect(send.mock.calls[0][1].headers.Authorization).toBe('Bearer proxy-secret')
    expect(JSON.parse(send.mock.calls[0][1].body)).not.toHaveProperty('checkProxyHeaders')
    expect(send.mock.calls[0][1].redirect).toBe('manual')
  })
  it('preserves typed Go TLS expiry diagnostics even without a phase prefix in the message', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({
              location: 'Tokyo',
              status: {
                up: false,
                ping: 4,
                err: 'TLS certificate expires within the configured warning window',
                stage: 'tls',
                code: 'expiring',
                certificate_expires_at: 2000000000,
                certificate_days_remaining: 2,
              },
            })
          )
        )
    )
    const result = await doMonitor(
      { ...base().monitors[0], method: 'SSL_CERT', checkProxy: 'https://proxy.test/v1/check' },
      'SIN',
      {} as any
    )
    expect(result.status.stage).toBe('tls')
    expect(result.status.code).toBe('expiring')
    expect(result.status.certificate_days_remaining).toBe(2)
  })
  it('keeps ICMP proxy authentication separate and prefers its explicit RTT measurement', async () => {
    const send = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ up: true, latency_ms: 4, icmp_latency_ms: 0.25 }))
      )
    vi.stubGlobal('fetch', send)
    const status = await getStatus({
      ...base().monitors[0],
      method: 'ICMP_PING',
      target: 'example.test',
      icmpProxyURL: 'https://proxy.test/v1/ping',
      headers: { Authorization: 'old-secret' },
      checkProxyHeaders: { Authorization: 'proxy-secret' },
    })
    expect(status.icmp_latency_ms).toBe(0.25)
    expect(send.mock.calls[0][1].headers.Authorization).toBe('proxy-secret')
  })
  it('attributes a stalled proxy response body to proxy timeout, not the target body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(new ReadableStream({ start() {} })))
    )
    const result = await doMonitor(
      { ...base().monitors[0], checkProxy: 'https://proxy.test/v1/check', timeout: 10 },
      'SIN',
      {} as any
    )
    expect(result.status.stage).toBe('proxy')
    expect(result.status.code).toBe('timeout')
  })
  it('uses ICMP proxy RTT and retains the target phase for an unreachable echo', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ up: false, latency_ms: 5, stage: 'icmp', code: 'timeout' }))
        )
    )
    const status = await getStatus({
      ...base().monitors[0],
      method: 'ICMP_PING',
      target: 'example.test',
      icmpProxyURL: 'https://proxy.test/v1/ping',
    })
    expect(status.err).toMatch(/^\[icmp\/timeout\]/)
    expect(status.icmp_latency_ms).toBe(5)
  })
  it('requests a real ICMP Globalping measurement and rejects completed packet loss', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ id: 'measurement' }), { status: 202 }))
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: 'finished',
            results: [
              {
                probe: { country: 'JP', city: 'Tokyo' },
                result: { status: 'finished', stats: { avg: 0, rcv: 0, loss: 100 } },
              },
            ],
          })
        )
      )
    vi.stubGlobal('fetch', send)
    const result = await getStatusWithGlobalPing({
      ...base().monitors[0],
      method: 'ICMP_PING',
      target: 'example.test',
      checkProxy: 'globalping://?magic=Tokyo',
    })
    expect(JSON.parse(send.mock.calls[0][1].body).measurementOptions.protocol).toBe('icmp')
    expect(result.status.up).toBe(false)
    expect(result.status.err).toMatch(/icmp/)
  })
})
