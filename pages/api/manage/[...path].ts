import type { NextRequest } from 'next/server'
import { workerConfig } from '@/uptime.config'
import { handleManagementRequest } from '@/worker/src/management'

export const runtime = 'edge'

export default function handler(request: NextRequest): Promise<Response> {
  // next-on-pages injects catch-all metadata into the URL. Scope always comes
  // from the pathname; real query parameters remain subject to strict rejection.
  const url = new URL(request.url)
  const route = url.pathname.slice('/api/manage/'.length)
  for (const key of ['nxtPpath', 'path']) {
    const values = url.searchParams.getAll(key)
    if (values.length === 1 && values[0] === route) url.searchParams.delete(key)
  }
  return handleManagementRequest(new Request(url, request), process.env as any, workerConfig)
}
