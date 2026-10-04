/** Optional legacy page password. Bearer APIs retain their independent authentication. */
export function pageAccess(request: Request, password?: string): Response | null {
  const pathname = new URL(request.url).pathname
  if (
    !password ||
    pathname === '/api/probes/config' ||
    pathname === '/api/probes/ingest' ||
    /^\/api\/manage\/(?:groups|status|(?:groups|monitors)\/[^/]+\/(?:status|enable|disable))$/.test(
      pathname
    )
  )
    return null
  const expected = 'Basic ' + btoa(password)
  const actual = request.headers.get('Authorization') ?? ''
  let difference = actual.length ^ expected.length
  for (let i = 0; i < expected.length; i++)
    difference |= (actual.charCodeAt(i) || 0) ^ expected.charCodeAt(i)
  return difference
    ? Response.json(
        { error: 'Not authenticated' },
        { status: 401, headers: { 'WWW-Authenticate': 'Basic' } }
      )
    : null
}
