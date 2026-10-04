import type { NextRequest } from 'next/server'
import { workerConfig } from '@/uptime.config'
import { handleAdminRequest } from '@/worker/src/admin'

export const runtime = 'edge'

export default function handler(request: NextRequest): Promise<Response> {
  return handleAdminRequest(request, process.env as any, workerConfig)
}
