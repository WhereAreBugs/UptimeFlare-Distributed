import { classifyNativeFailure } from './diagnostics'
import { MonitorTarget, WebhookConfig, WorkerConfig } from '../../types/config'
import { workerConfig } from '../../uptime.config'
import { isInMaintenance } from '../../util/maintenance'

/** Bound keyword responses and include body reads in the configured check deadline. */
export async function readResponseBody(response: Response, deadline: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let bytes = 0
  try {
    while (true) {
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new Error('[body/timeout] HTTP response body timed out')
      let part: ReadableStreamReadResult<Uint8Array>
      try {
        part = await withTimeout(remaining, reader.read())
      } catch (error) {
        if (Date.now() >= deadline || classifyNativeFailure(error).code === 'timeout')
          throw new Error('[body/timeout] HTTP response body timed out')
        throw error
      }
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > 1024 * 1024) throw new Error('[body/too_large] HTTP response body exceeds 1 MiB')
      chunks.push(decoder.decode(part.value, { stream: true }))
    }
    chunks.push(decoder.decode())
    return chunks.join('')
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

async function getWorkerLocation() {
  const deadline = Date.now() + 3000
  const res = await fetchTimeout('https://cloudflare.com/cdn-cgi/trace', 3000)
  const text = await readResponseBody(res, deadline)

  const colo = /^colo=(.*)$/m.exec(text)?.[1]
  return colo
}

const fetchTimeout = (
  url: string,
  ms: number,
  { signal, ...options }: RequestInit<RequestInitCfProperties> | undefined = {}
): Promise<Response> => {
  const controller = new AbortController()
  const abort = () => controller.abort()
  if (signal?.aborted) abort()
  signal?.addEventListener('abort', abort, { once: true })
  const promise = fetch(url, { signal: controller.signal, ...options, redirect: 'manual' })
  const timeout = setTimeout(() => controller.abort(), ms)
  return promise.finally(() => {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', abort)
  })
}

function withTimeout<T>(millis: number, promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Promise timed out after ${millis}ms`)), millis)
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

function formatStatusChangeNotification(
  monitor: any,
  isUp: boolean,
  timeIncidentStart: number,
  timeNow: number,
  reason: string,
  timeZone: string
) {
  const dateFormatter = new Intl.DateTimeFormat('en-US', {
    month: 'numeric',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZone: timeZone,
  })

  let downtimeDuration = Math.round((timeNow - timeIncidentStart) / 60)
  const timeNowFormatted = dateFormatter.format(new Date(timeNow * 1000))
  const timeIncidentStartFormatted = dateFormatter.format(new Date(timeIncidentStart * 1000))

  if (isUp) {
    return `✅ ${monitor.name} is up! \nThe service is up again after being down for ${downtimeDuration} minutes.`
  } else if (timeNow == timeIncidentStart) {
    return `🔴 ${
      monitor.name
    } is currently down. \nService is unavailable at ${timeNowFormatted}. \nIssue: ${
      reason || 'unspecified'
    }`
  } else {
    return `🔴 ${
      monitor.name
    } is still down. \nService is unavailable since ${timeIncidentStartFormatted} (${downtimeDuration} minutes). \nIssue: ${
      reason || 'unspecified'
    }`
  }
}

function templateWebhookPlayload(payload: any, message: string) {
  for (const key in payload) {
    if (Object.prototype.hasOwnProperty.call(payload, key)) {
      if (payload[key] === '$MSG') {
        payload[key] = message
      } else if (typeof payload[key] === 'object' && payload[key] !== null) {
        templateWebhookPlayload(payload[key], message)
      }
    }
  }
}

async function webhookNotify(webhook: WebhookConfig, message: string) {
  if (Array.isArray(webhook)) {
    for (const w of webhook) {
      await webhookNotify(w, message)
    }
    return
  }

  console.log('Sending webhook notification')
  try {
    let url = webhook.url
    let method = webhook.method
    let headers = new Headers(webhook.headers as any)
    let payloadTemplated: { [key: string]: string | number } = JSON.parse(
      JSON.stringify(webhook.payload)
    )
    templateWebhookPlayload(payloadTemplated, message)
    let body = undefined

    switch (webhook.payloadType) {
      case 'param':
        method = method ?? 'GET'
        const urlTmp = new URL(url)
        for (const [k, v] of Object.entries(payloadTemplated)) {
          urlTmp.searchParams.append(k, v.toString())
        }
        url = urlTmp.toString()
        break
      case 'json':
        method = method ?? 'POST'
        if (headers.get('content-type') === null) {
          headers.set('content-type', 'application/json')
        }
        body = JSON.stringify(payloadTemplated)
        break
      case 'x-www-form-urlencoded':
        method = method ?? 'POST'
        if (headers.get('content-type') === null) {
          headers.set('content-type', 'application/x-www-form-urlencoded')
        }
        body = new URLSearchParams(payloadTemplated as any).toString()
        break
      default:
        throw 'Unrecognized payload type: ' + webhook.payloadType
    }

    const resp = await fetchTimeout(url, webhook.timeout ?? 5000, {
      method,
      headers,
      body,
      redirect: 'manual',
    })

    await resp.body?.cancel()
    if (!resp.ok) {
      console.log('Webhook returned an unsuccessful HTTP response, code: ' + resp.status)
    } else {
      console.log('Webhook notification sent successfully, code: ' + resp.status)
    }
  } catch (e) {
    console.error('Webhook request failed')
  }
}

// Auxiliary function to format notification and send it via webhook
const formatAndNotify = async (
  monitor: MonitorTarget,
  isUp: boolean,
  timeIncidentStart: number,
  timeNow: number,
  reason: string,
  config: WorkerConfig = workerConfig
) => {
  // Skip notification if monitor is in the skip list
  const skipList = config.notification?.skipNotificationIds
  if (skipList && skipList.includes(monitor.id)) {
    console.log(`Skipping notification for ${monitor.name} (${monitor.id} in skipNotificationIds)`)
    return
  }

  // Skip notification if monitor is in maintenance
  if (isInMaintenance(config, monitor.id, timeNow)) {
    console.log(`Skipping notification for ${monitor.name} (in maintenance)`)
    return
  }

  if (config.notification?.webhook) {
    const notification = formatStatusChangeNotification(
      monitor,
      isUp,
      timeIncidentStart,
      timeNow,
      reason,
      config.notification?.timeZone ?? 'Etc/GMT'
    )
    await webhookNotify(config.notification.webhook, notification)
  } else {
    console.log(`Webhook not set, skipping notification for ${monitor.name}`)
  }
}

export {
  getWorkerLocation,
  fetchTimeout,
  withTimeout,
  webhookNotify,
  formatStatusChangeNotification,
  formatAndNotify,
}
