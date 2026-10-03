import type { MonitorTarget, SingleWebhook, WorkerConfig } from '../../types/config'
import type { ProbeEnv } from './probes'
import { getProbeSummaries } from './probes'
import { CompactedMonitorStateWrapper, getFromStore } from './store'
import pLimit from 'p-limit'

export type NotificationEvent = {
  eventId: string
  monitorName: string
  status: 'up' | 'down'
  time: string
  reason: string
  duration: number
  message: string
}
type NotificationState = {
  template_id: string
  status: 'up' | 'down'
  down_since: number | null
  observed_at: number
  version: number
}
type Job = {
  event_id: string
  monitor_id: string
  template_id: string
  value: string
  attempts: number
}

/** Persist a transition and its event in one transaction; concurrent cron runs cannot duplicate it. */
export async function queueNotification(
  env: ProbeEnv,
  monitor: MonitorTarget,
  status: 'up' | 'down',
  sampleTime: number,
  reason: string,
  now: number
) {
  const templateId = monitor.notificationTemplateId!
  const previous = await env.UPTIMEFLARE_D1.prepare(
    'SELECT * FROM notification_state WHERE monitor_id=?'
  )
    .bind(monitor.id)
    .first<NotificationState>()
  if (
    previous &&
    (now <= previous.observed_at ||
      (previous.template_id === templateId && previous.status === status))
  )
    return
  const sameTemplate = previous?.template_id === templateId
  const notify = status === 'down' || (sameTemplate && previous?.status === 'down')
  const downSince = status === 'down' ? sampleTime : previous?.down_since ?? sampleTime
  const event: NotificationEvent = {
    eventId: crypto.randomUUID(),
    monitorName: monitor.name,
    status,
    time: new Date(sampleTime * 1000).toISOString(),
    reason: reason.slice(0, 1024),
    duration: status === 'up' ? Math.max(0, sampleTime - downSince) : 0,
    message: '',
  }
  event.message =
    status === 'down'
      ? `🔴 ${monitor.name} 不可达。${event.reason ? `失败原因：${event.reason}` : ''}`
      : `✅ ${monitor.name} 已恢复，故障持续 ${event.duration} 秒。`
  const version = previous?.version ?? 0
  const statements = [
    env.UPTIMEFLARE_D1.prepare(
      "INSERT OR IGNORE INTO notification_state (monitor_id,template_id,status,down_since,observed_at,version) VALUES (?,'','up',NULL,0,0)"
    ).bind(monitor.id),
  ]
  if (notify)
    statements.push(
      env.UPTIMEFLARE_D1.prepare(
        'INSERT INTO notification_outbox (event_id,monitor_id,template_id,sequence,value,created_at,next_attempt_at) SELECT ?,?,?,?,?,?,? FROM notification_state WHERE monitor_id=? AND version=?'
      ).bind(
        event.eventId,
        monitor.id,
        templateId,
        version + 1,
        JSON.stringify(event),
        now,
        now,
        monitor.id,
        version
      )
    )
  statements.push(
    env.UPTIMEFLARE_D1.prepare(
      'UPDATE notification_state SET template_id=?,status=?,down_since=?,observed_at=?,version=version+1 WHERE monitor_id=? AND version=?'
    ).bind(templateId, status, status === 'down' ? downSince : null, now, monitor.id, version)
  )
  const results = await env.UPTIMEFLARE_D1.batch(statements)
  if (results.some((result) => !result.success)) throw new Error('Notification persistence failed')
}

function renderPayload(payload: unknown, event: NotificationEvent): unknown {
  const variables: Record<string, string> = {
    MSG: event.message,
    MONITOR: event.monitorName,
    STATUS: event.status,
    TIME: event.time,
    REASON: event.reason,
    DURATION: String(event.duration),
    EVENT_ID: event.eventId,
  }
  if (typeof payload === 'string')
    return payload.replace(
      /\$(MSG|MONITOR|STATUS|TIME|REASON|DURATION|EVENT_ID)\b/g,
      (_, key) => variables[key]
    )
  if (Array.isArray(payload)) return payload.map((item) => renderPayload(item, event))
  if (payload && typeof payload === 'object')
    return Object.fromEntries(
      Object.entries(payload).map(([key, value]) => [key, renderPayload(value, event)])
    )
  return payload
}

/** Never log URLs, credentials, request bodies or remote responses. Do not forward credentials through redirects. */
export async function sendTemplateWebhook(
  webhook: SingleWebhook,
  event: NotificationEvent,
  send: typeof fetch = fetch
): Promise<void> {
  const headers = new Headers(webhook.headers as Record<string, string>)
  headers.set('X-UptimeFlare-Event-ID', event.eventId)
  if (!headers.has('Idempotency-Key')) headers.set('Idempotency-Key', event.eventId)
  const payload = renderPayload(webhook.payload, event) as Record<string, unknown>
  const url = new URL(webhook.url)
  let body: string | undefined
  if (webhook.payloadType === 'param') {
    for (const [key, value] of Object.entries(payload))
      url.searchParams.append(key, String(value ?? ''))
  } else if (webhook.payloadType === 'json') {
    body = JSON.stringify(payload)
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  } else {
    body = new URLSearchParams(
      Object.entries(payload).map(([key, value]): [string, string] => [key, String(value ?? '')])
    ).toString()
    if (!headers.has('Content-Type'))
      headers.set('Content-Type', 'application/x-www-form-urlencoded')
  }
  if (new TextEncoder().encode(body ?? url.toString()).length > 64 * 1024)
    throw new Error('Webhook payload too large')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), webhook.timeout ?? 5000)
  try {
    const response = await send(url.toString(), {
      method: webhook.method ?? (webhook.payloadType === 'param' ? 'GET' : 'POST'),
      headers,
      body,
      signal: controller.signal,
      redirect: 'manual',
    })
    await response.body?.cancel()
    if (!response.ok) throw new Error('Webhook delivery failed')
  } finally {
    clearTimeout(timer)
  }
}

export async function deliverNotifications(
  env: ProbeEnv,
  config: WorkerConfig,
  now: number,
  send: typeof fetch = fetch
) {
  const templates = new Map(
    (config.notificationTemplates ?? []).map((template) => [template.id, template])
  )
  const active = new Map(
    config.monitors
      .filter((monitor) => templates.has(monitor.notificationTemplateId ?? ''))
      .map((monitor) => [monitor.id, monitor.notificationTemplateId])
  )
  const jobs = await env.UPTIMEFLARE_D1.prepare(
    'SELECT * FROM notification_outbox j WHERE next_attempt_at<=? AND lease_until<=? AND attempts<8 AND NOT EXISTS (SELECT 1 FROM notification_outbox older WHERE older.monitor_id=j.monitor_id AND older.sequence<j.sequence AND older.attempts<8) ORDER BY created_at,event_id LIMIT 20'
  )
    .bind(now, now)
    .all<Job>()
  if (!jobs.success) throw new Error('Notification queue read failed')
  const limit = pLimit(3)
  await Promise.all(
    jobs.results.map((job) =>
      limit(async () => {
        if (active.get(job.monitor_id) !== job.template_id) {
          await env.UPTIMEFLARE_D1.prepare('DELETE FROM notification_outbox WHERE event_id=?')
            .bind(job.event_id)
            .run()
          return
        }
        const lease = crypto.randomUUID()
        const claimed = await env.UPTIMEFLARE_D1.prepare(
          'UPDATE notification_outbox SET lease_until=?,lease_key=?,attempts=attempts+1 WHERE event_id=? AND lease_until<=? AND next_attempt_at<=? AND attempts<8 RETURNING *'
        )
          .bind(now + 120, lease, job.event_id, now, now)
          .first<Job>()
        if (!claimed) return
        try {
          await sendTemplateWebhook(
            templates.get(job.template_id)!.webhook,
            JSON.parse(job.value),
            send
          )
          await env.UPTIMEFLARE_D1.prepare(
            'DELETE FROM notification_outbox WHERE event_id=? AND lease_key=?'
          )
            .bind(job.event_id, lease)
            .run()
        } catch {
          await env.UPTIMEFLARE_D1.prepare(
            "UPDATE notification_outbox SET lease_until=0,lease_key='',next_attempt_at=? WHERE event_id=? AND lease_key=?"
          )
            .bind(now + Math.min(3600, 60 * 2 ** (claimed.attempts - 1)), job.event_id, lease)
            .run()
          console.error(
            claimed.attempts >= 8
              ? 'Webhook notification exhausted retries'
              : 'Webhook notification queued for retry'
          )
        }
      })
    )
  )
}

/** Evaluated once per cron minute from fresh latest results, never from historical upload events. */
export async function runNotifications(
  env: ProbeEnv,
  config: WorkerConfig,
  now: number,
  send: typeof fetch = fetch
) {
  const templateIds = new Set((config.notificationTemplates ?? []).map((template) => template.id))
  const monitors = config.monitors.filter((monitor) =>
    templateIds.has(monitor.notificationTemplateId ?? '')
  )
  const activeIds = JSON.stringify(monitors.map((monitor) => monitor.id))
  const cleanup = await env.UPTIMEFLARE_D1.batch([
    env.UPTIMEFLARE_D1.prepare(
      'DELETE FROM notification_state WHERE monitor_id IN (SELECT monitor_id FROM notification_state WHERE monitor_id NOT IN (SELECT value FROM json_each(?)) LIMIT 1000)'
    ).bind(activeIds),
    env.UPTIMEFLARE_D1.prepare(
      'DELETE FROM notification_outbox WHERE event_id IN (SELECT event_id FROM notification_outbox WHERE monitor_id NOT IN (SELECT value FROM json_each(?)) OR created_at<? LIMIT 1000)'
    ).bind(activeIds, now - 7 * 86400),
  ])
  if (cleanup.some((result) => !result.success)) throw new Error('Notification cleanup failed')
  if (!monitors.length) return
  const summaries = await getProbeSummaries(
    env,
    monitors,
    config.probes,
    now,
    config.probeStaleAfterSeconds
  )
  const native = monitors.some((monitor) => !monitor.probes?.length)
    ? new CompactedMonitorStateWrapper(await getFromStore(env, 'state'))
    : null
  for (const monitor of monitors) {
    const summary = summaries[monitor.id]
    if (summary) {
      if (summary.status !== 'up' && summary.status !== 'down') continue
      const reason = summary.probes
        .filter((probe) => probe.status === 'down')
        .map((probe) => `${probe.name}: ${probe.stage ?? 'unknown'}/${probe.code ?? 'unknown'}`)
        .join('; ')
      await queueNotification(env, monitor, summary.status, summary.latest ?? now, reason, now)
    } else if (
      native &&
      native.data.lastUpdate >= now - (config.probeStaleAfterSeconds ?? 900) &&
      native.incidentLen(monitor.id)
    ) {
      const incident = native.getIncident(monitor.id, native.incidentLen(monitor.id) - 1)
      await queueNotification(
        env,
        monitor,
        incident.end === null ? 'down' : 'up',
        native.data.lastUpdate,
        incident.end === null ? incident.error[incident.error.length - 1] ?? '' : '',
        now
      )
    }
  }
  await deliverNotifications(env, config, now, send)
}
