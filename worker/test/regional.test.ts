import { expect, it, vi } from 'vitest'
import { RegionalExecutor, validateRegionalResponse, type RegionalRequest } from '../src/regional'
const targets = Array.from({ length: 10 }, (_, i) => ({
  id: 't' + i,
  name: 'Target',
  target: 'https://example.org',
  method: 'GET',
}))
async function request(runId = 'run'): Promise<RegionalRequest> {
  const configVersion = Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(targets)))
    ),
    (b) => b.toString(16).padStart(2, '0')
  ).join('')
  return { version: 1, runId, configVersion, monitors: targets }
}
it('bounds overlapping RPCs by the instance queue and caches successful location', async () => {
  let active = 0,
    peak = 0
  const locate = vi.fn(async () => 'SIN')
  const executor = new RegionalExecutor(async () => {
    peak = Math.max(peak, ++active)
    await new Promise((r) => setTimeout(r, 2))
    active--
    return { up: true, ping: 0, err: '' }
  }, locate)
  const a = await request('a'),
    b = await request('b')
  const [ra, rb] = await Promise.all([executor.checkBatch(a), executor.checkBatch(b)])
  expect(peak).toBe(5)
  expect(locate).toHaveBeenCalledTimes(1)
  expect(validateRegionalResponse(ra, a)).toHaveLength(10)
  expect(validateRegionalResponse(rb, b)).toHaveLength(10)
})
it('cools down location failures without turning successful targets DOWN', async () => {
  const locate = vi.fn(async () => {
    throw new Error('location service')
  })
  const executor = new RegionalExecutor(async () => ({ up: true, ping: 1, err: '' }), locate)
  const value = await executor.checkBatch(await request())
  expect(value.results.every((r) => r.status.up)).toBe(true)
  expect(locate).toHaveBeenCalledTimes(1)
  await executor.checkBatch(await request('second'))
  expect(locate).toHaveBeenCalledTimes(1)
})
it('allows reordered results and rejects duplicates, missing targets, versions and invalid numbers', async () => {
  const req = await request(),
    executor = new RegionalExecutor(
      async () => ({ up: true, ping: 1, err: '' }),
      async () => 'SIN'
    )
  const response = await executor.checkBatch(req)
  expect(
    validateRegionalResponse({ ...response, results: [...response.results].reverse() }, req)
  ).toHaveLength(10)
  for (const bad of [
    { ...response, version: 2 },
    { ...response, runId: 'wrong' },
    { ...response, results: response.results.slice(1) },
    { ...response, results: response.results.map(() => response.results[0]) },
    {
      ...response,
      results: response.results.map((r) => ({ ...r, status: { ...r.status, ping: NaN } })),
    },
  ])
    expect(() => validateRegionalResponse(bad, req)).toThrow()
})
it('uses changed private configuration, retries location after cooldown and reconstructs its cache', async () => {
  vi.useFakeTimers()
  try {
    const locate = vi.fn().mockRejectedValueOnce(new Error('temporary')).mockResolvedValue('NRT')
    const check = vi.fn(async (m: any) => ({
      up: true,
      ping: m.headers?.value === 'new' ? 2 : 1,
      err: '',
    }))
    const executor = new RegionalExecutor(check, locate),
      original = await request()
    expect((await executor.checkBatch(original)).results[0].location).toBe('UNKNOWN')
    const monitors = original.monitors.map((m) => ({ ...m, headers: { value: 'new' } }))
    const configVersion = Array.from(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(monitors)))
      ),
      (b) => b.toString(16).padStart(2, '0')
    ).join('')
    await vi.advanceTimersByTimeAsync(60001)
    expect(
      (await executor.checkBatch({ ...original, monitors, configVersion })).results[0]
    ).toMatchObject({ location: 'NRT', status: { ping: 2 } })
    expect(locate).toHaveBeenCalledTimes(2)
    await new RegionalExecutor(check, locate).checkBatch(original)
    expect(locate).toHaveBeenCalledTimes(3)
    await expect(executor.checkBatch({ ...original, monitors })).rejects.toThrow('fingerprint')
  } finally {
    vi.useRealTimers()
  }
})
it('reserves regional fallback and Globalping costs without exceeding the root budget', async () => {
  const { admitByLocation, createExecutionBudget } = await import('../src/execution-budget')
  const budget = createExecutionBudget()
  const admitted = admitByLocation(
    Array.from({ length: 100 }, (_, i) => ({
      ...targets[0],
      id: 'f' + i,
      checkProxy: 'worker://wnam',
      checkProxyFallback: true,
    })),
    budget
  )
  expect(admitted).toHaveLength(29)
  expect(budget.locations!.get('root')).toBe(0)
  const second = createExecutionBudget()
  expect(
    admitByLocation(
      [
        { ...targets[0], checkProxy: 'globalping://Tokyo' },
        { ...targets[1], checkProxy: 'globalping://Tokyo' },
      ],
      second
    )
  ).toHaveLength(1)
  expect(second.locations!.get('root')).toBe(10)
})
it('preserves independent successful samples when another checker throws', async () => {
  const { checkMonitors } = await import('../src/regional')
  const result = await checkMonitors(targets, 'SIN', {} as any, async (m) => {
    if (m.id === 't0') throw new Error('system fault')
    return { id: m.id, location: 'SIN', status: { up: true, ping: 1, err: '' } }
  })
  expect(result).toHaveLength(9)
  expect(result.every((r) => r.status.up)).toBe(true)
})
