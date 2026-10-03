import type { NextRequest } from 'next/server'
import { workerConfig } from '@/uptime.config'
import { handleProbeRequest } from '@/worker/src/probes'

export const runtime = 'edge'

export default function handler(request: NextRequest): Promise<Response> {
  return handleProbeRequest(request, process.env as any, workerConfig.monitors)
}
