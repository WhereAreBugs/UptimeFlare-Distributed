import type { NextRequest } from 'next/server'
import { workerConfig } from '@/uptime.config'
import { getRuntimeConfig } from '@/worker/src/settings'
import { handleProbeRequest, preflightProbeRequest } from '@/worker/src/probes'

export const runtime = 'edge'

export default async function handler(request: NextRequest): Promise<Response> {
  const preflight = preflightProbeRequest(request, process.env as any)
  if (preflight) return preflight
  const config = await getRuntimeConfig(process.env as any, workerConfig)
  return handleProbeRequest(
    request,
    process.env as any,
    config.monitors,
    (request as NextRequest & { cf?: IncomingRequestCfProperties }).cf
  )
}
