import type { NextRequest } from 'next/server'
import { workerConfig } from '@/uptime.config'
import { getRuntimeConfig } from '@/worker/src/settings'
import { handlePublicHistoryRequest } from '@/worker/src/history'

export const runtime = 'edge'
export default async function handler(request: NextRequest): Promise<Response> {
  if (request.method !== 'GET')
    return handlePublicHistoryRequest(request, process.env as any, workerConfig)
  const config = await getRuntimeConfig(process.env as any, workerConfig)
  return handlePublicHistoryRequest(request, process.env as any, config)
}
