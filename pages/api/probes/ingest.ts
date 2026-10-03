import type { NextRequest } from 'next/server'
import { workerConfig } from '@/uptime.config'
import { getRuntimeConfig } from '@/worker/src/settings'
import { handleProbeRequest } from '@/worker/src/probes'

export const runtime = 'edge'

export default async function handler(request: NextRequest): Promise<Response> {
  const config = await getRuntimeConfig(process.env as any, workerConfig)
  return handleProbeRequest(request, process.env as any, config.monitors)
}
