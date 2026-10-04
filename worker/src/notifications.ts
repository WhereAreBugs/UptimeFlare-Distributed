import { getMonitorStaleAfterSeconds } from '../../util/monitor-settings'
import type { MonitorTarget, SingleWebhook, WorkerConfig } from '../../types/config'
import type { ProbeEnv } from './probes'
import { getProbeSummaries } from './probes'
import { CompactedMonitorStateWrapper, getFromStore } from './store'
import pLimit from 'p-limit'
import { expandMaintenances, maintenanceTime, getPresentationSettings } from '../../util/maintenance'
import { NOT_PAUSED_IN_SAVED_CONFIG, pauseTransitionStatements, withSavedPauseFlags } from './pause'

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

type Observation = {
  template_id: string
  status: 'up' | 'down' | 'paused' | 'awaiting'
  down_since: number | null
  sample_time: number
  observed_at: number
  reason: string
  notified: number
  version: number
}

/** Observation, grace decision and queued transition commit atomically under a version fence. */
export async function queueNotification(
  env: ProbeEnv,
  monitor: MonitorTarget,
  status: 'up' | 'down',
  sampleTime: number,
  reason: string,
  now: number,
  options: { graceSeconds?: number; skipReasonChanges?: boolean; suppressed?: boolean; timeZone?: string; reasonKey?: string; configGuard?: string } = {}
) {
  if (monitor.paused) return
  const templateId = monitor.notificationTemplateId!
  const configGuard = options.configGuard ?? '1'
  const [observation, previous] = await Promise.all([
    env.UPTIMEFLARE_D1.prepare('SELECT * FROM notification_observations WHERE monitor_id=?').bind(monitor.id).first<Observation>(),
    env.UPTIMEFLARE_D1.prepare('SELECT * FROM notification_state WHERE monitor_id=?').bind(monitor.id).first<NotificationState>(),
  ])
  if (observation && (now <= observation.observed_at || sampleTime < observation.sample_time)) return
  if (observation && (observation.status === 'paused' || observation.status === 'awaiting') && sampleTime <= observation.sample_time) return
  const sameTemplate = observation ? observation.template_id === templateId : previous?.template_id === templateId
  const priorStatus = observation?.status ?? (sameTemplate ? previous?.status : undefined)
  const priorNotified = sameTemplate && (observation ? !!observation.notified : previous?.status === 'down')
  const continuous = sameTemplate && priorStatus === 'down' && (!observation || sampleTime-observation.sample_time <= getMonitorStaleAfterSeconds(monitor))
  const downSince = status === 'down' && continuous
    ? observation?.down_since ?? previous?.down_since ?? sampleTime : sampleTime
  const grace = options.graceSeconds ?? 0
  const reasonKey = (options.reasonKey ?? reason).slice(0,4096)
  const notify = !options.suppressed && (
    status === 'down'
      ? (!priorNotified && sampleTime-downSince >= grace)
        || (priorNotified && !!observation && options.skipReasonChanges === false && reasonKey !== observation.reason)
      : priorStatus === 'down' && priorNotified
  )
  const notified = !options.suppressed && status === 'down' && (notify || priorNotified)
  const version = observation?.version ?? 0
  const event: NotificationEvent = {
    eventId: crypto.randomUUID(), monitorName: monitor.name, status,
    time: new Date(sampleTime*1000).toISOString(), reason: reason.slice(0,1024),
    duration: status === 'up' ? Math.max(0,sampleTime-(observation?.down_since ?? previous?.down_since ?? sampleTime)) : 0,
    message: '',
  }
  const time = new Intl.DateTimeFormat('zh-CN', { timeZone: options.timeZone ?? 'UTC', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(sampleTime*1000))
  event.message = status === 'down'
    ? `🔴 ${monitor.name} 不可达。${event.reason ? `失败原因：${event.reason}` : ''} (${time})`
    : `✅ ${monitor.name} 已恢复，故障持续 ${event.duration} 秒。 (${time})`
  const statements = [
    env.UPTIMEFLARE_D1.prepare(`INSERT OR IGNORE INTO notification_observations(monitor_id,template_id,status,down_since,sample_time,observed_at,reason,notified,version) SELECT ?,'','up',NULL,0,0,'',0,0 WHERE (${configGuard})`).bind(monitor.id),
    env.UPTIMEFLARE_D1.prepare(`INSERT OR IGNORE INTO notification_state(monitor_id,template_id,status,down_since,observed_at,version) SELECT ?,'','up',NULL,0,0 WHERE (${configGuard})`).bind(monitor.id),
  ]
  if (notify) statements.push(env.UPTIMEFLARE_D1.prepare(
    `INSERT INTO notification_outbox(event_id,monitor_id,template_id,sequence,value,created_at,next_attempt_at) SELECT ?,?,?,n.version+1,?,?,? FROM notification_observations o JOIN notification_state n USING(monitor_id) WHERE o.monitor_id=? AND o.version=? AND (${configGuard}) AND ${NOT_PAUSED_IN_SAVED_CONFIG('o.monitor_id')}`
  ).bind(event.eventId,monitor.id,templateId,JSON.stringify(event),now,now,monitor.id,version))
  statements.push(env.UPTIMEFLARE_D1.prepare(
    `UPDATE notification_state SET template_id=?,status=?,down_since=?,observed_at=?,version=version+1 WHERE monitor_id=? AND EXISTS(SELECT 1 FROM notification_observations WHERE monitor_id=? AND version=?) AND (${configGuard}) AND ${NOT_PAUSED_IN_SAVED_CONFIG('notification_state.monitor_id')}`
  ).bind(templateId,status,status === 'down' ? downSince : null,now,monitor.id,monitor.id,version))
  statements.push(env.UPTIMEFLARE_D1.prepare(
    `UPDATE notification_observations SET template_id=?,status=?,down_since=?,sample_time=?,observed_at=?,reason=?,notified=?,version=version+1 WHERE monitor_id=? AND version=? AND (${configGuard}) AND ${NOT_PAUSED_IN_SAVED_CONFIG('notification_observations.monitor_id')}`
  ).bind(templateId,status,status === 'down' ? downSince : null,sampleTime,now,reasonKey,notified ? 1 : 0,monitor.id,version))
  const results=await env.UPTIMEFLARE_D1.batch(statements)
  if(results.some(result=>!result.success)) throw new Error('Notification persistence failed')
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

/** Source-config webhooks use the same durable grace/outbox path as named templates. */
function effectiveNotificationConfig(source: WorkerConfig) {
  const value = source.notification?.webhook
  const hooks: SingleWebhook[] = value ? (Array.isArray(value) ? value : [value]) : []
  if (!hooks.length) return { config: source, sourceTemplateId: '', hooks }
  const ids = new Set((source.notificationTemplates ?? []).map(template => template.id))
  let sourceTemplateId = '__source_webhook__'
  while (ids.has(sourceTemplateId)) sourceTemplateId += '_'
  const config: WorkerConfig = {
    ...source,
    notificationTemplates: [...(source.notificationTemplates ?? []), { id: sourceTemplateId, name: 'Source webhook', type: 'webhook', webhook: hooks[0] }],
    monitors: source.monitors.map(monitor => !monitor.probes?.length && !monitor.notificationTemplateId
      ? { ...monitor, notificationTemplateId: sourceTemplateId } : monitor),
  }
  return { config, sourceTemplateId, hooks }
}

export async function deliverNotifications(
  env: ProbeEnv,
  config: WorkerConfig,
  now: number,
  send: typeof fetch = fetch
) {
  const snapshot = await withSavedPauseFlags(env, config.monitors)
  config = { ...config, monitors: snapshot.monitors }
  const { config: effective, sourceTemplateId, hooks } = effectiveNotificationConfig(config)
  config = effective
  const templates = new Map(
    (config.notificationTemplates ?? []).map((template) => [template.id, template])
  )
  const suppressed = suppressedMonitors(config, now)
  const active = new Map(
    config.monitors
      .filter((monitor) => templates.has(monitor.notificationTemplateId ?? '') && !suppressed.has(monitor.id))
      .map((monitor) => [monitor.id, monitor.notificationTemplateId])
  )
  const cancelled = await env.UPTIMEFLARE_D1.prepare(`DELETE FROM notification_outbox WHERE event_id IN (SELECT event_id FROM notification_outbox WHERE monitor_id NOT IN (SELECT value FROM json_each(?)) LIMIT 1000) AND (${snapshot.guard})`)
    .bind(JSON.stringify(Array.from(active.keys()))).run()
  if (!cancelled.success) throw new Error('Notification cancellation failed')
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
          await env.UPTIMEFLARE_D1.prepare(`DELETE FROM notification_outbox WHERE event_id=? AND (${snapshot.guard})`)
            .bind(job.event_id)
            .run()
          return
        }
        const lease = crypto.randomUUID()
        const claimed = await env.UPTIMEFLARE_D1.prepare(
          `UPDATE notification_outbox SET lease_until=?,lease_key=?,attempts=attempts+1 WHERE event_id=? AND lease_until<=? AND next_attempt_at<=? AND attempts<8 AND (${snapshot.guard}) AND ${NOT_PAUSED_IN_SAVED_CONFIG('notification_outbox.monitor_id')} RETURNING *`
        )
          .bind(now + 120, lease, job.event_id, now, now)
          .first<Job>()
        if (!claimed) return
        try {
          const webhooks = job.template_id === sourceTemplateId ? hooks : [templates.get(job.template_id)!.webhook]
          for (const webhook of webhooks) {
            // Admin pause deletes the outbox row atomically. Recheck before each outgoing request.
            const activeLease = await env.UPTIMEFLARE_D1.prepare(
              `SELECT 1 AS active FROM notification_outbox WHERE event_id=? AND lease_key=? AND (${snapshot.guard}) AND ${NOT_PAUSED_IN_SAVED_CONFIG('notification_outbox.monitor_id')}`
            ).bind(job.event_id, lease).first()
            if (!activeLease) return
            await sendTemplateWebhook(webhook, JSON.parse(job.value), send)
          }
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

function suppressedMonitors(config: WorkerConfig, now: number) {
  const active = expandMaintenances(getPresentationSettings(config).maintenances, now-1, now+1)
    .filter(plan => maintenanceTime(plan.start) <= now && (plan.end === undefined || maintenanceTime(plan.end) >= now))
  return new Set(config.monitors.filter(monitor => monitor.paused || config.notification?.skipNotificationIds?.includes(monitor.id)
    || active.some(plan => !plan.monitors?.length || plan.monitors.includes(monitor.id))).map(monitor => monitor.id))
}

/** Evaluated once per cron minute from fresh latest results, never from historical upload events. */
export async function runNotifications(
  env: ProbeEnv,
  config: WorkerConfig,
  now: number,
  send: typeof fetch = fetch
) {
  const snapshot = await withSavedPauseFlags(env, config.monitors)
  config = { ...config, monitors: snapshot.monitors }
  const sourceConfig = config
  config = effectiveNotificationConfig(config).config
  const markers = await env.UPTIMEFLARE_D1.prepare(
    'SELECT monitor_id,status,sample_time FROM notification_observations WHERE monitor_id IN (SELECT value FROM json_each(?))'
  ).bind(JSON.stringify(config.monitors.map(monitor => monitor.id))).all<{ monitor_id: string; status: string; sample_time: number }>()
  if (!markers.success) throw new Error('Notification pause read failed')
  const markerMap = new Map(markers.results.map(marker => [marker.monitor_id, marker]))
  const paused = config.monitors.filter(monitor => monitor.paused && markerMap.get(monitor.id)?.status !== 'paused')
  const resumed = markers.results.filter(marker => marker.status === 'paused' && !config.monitors.find(monitor => monitor.id === marker.monitor_id)?.paused)
  if (paused.length || resumed.length) {
    const results = await env.UPTIMEFLARE_D1.batch(pauseTransitionStatements(env,
      [...paused.map(monitor => ({ id: monitor.id, paused: true, native: !monitor.probes?.length })),
        ...resumed.map(marker => ({ id: marker.monitor_id, paused: false }))], now, snapshot.guard))
    if (results.some(result => !result.success)) throw new Error('Notification pause transition failed')
  }
  const resumeAfter = new Map(markers.results.filter(marker => marker.status === 'paused' || marker.status === 'awaiting').map(marker => [marker.monitor_id,
    resumed.some(value => value.monitor_id === marker.monitor_id) ? now : marker.sample_time]))
  const templateIds = new Set((config.notificationTemplates ?? []).map((template) => template.id))
  const monitors = config.monitors.filter((monitor) =>
    !monitor.paused && templateIds.has(monitor.notificationTemplateId ?? '')
  )
  const activeIds = JSON.stringify(monitors.map((monitor) => monitor.id))
  const cleanup = await env.UPTIMEFLARE_D1.batch([
    env.UPTIMEFLARE_D1.prepare(`DELETE FROM notification_observations WHERE monitor_id IN (SELECT monitor_id FROM notification_observations WHERE monitor_id NOT IN (SELECT value FROM json_each(?)) LIMIT 1000) AND (${snapshot.guard})`).bind(JSON.stringify(config.monitors.map(monitor => monitor.id))),
    env.UPTIMEFLARE_D1.prepare(
      `DELETE FROM notification_state WHERE monitor_id IN (SELECT monitor_id FROM notification_state WHERE monitor_id NOT IN (SELECT value FROM json_each(?)) LIMIT 1000) AND (${snapshot.guard})`
    ).bind(activeIds),
    env.UPTIMEFLARE_D1.prepare(
      `DELETE FROM notification_outbox WHERE event_id IN (SELECT event_id FROM notification_outbox WHERE monitor_id NOT IN (SELECT value FROM json_each(?)) OR created_at<? LIMIT 1000) AND (${snapshot.guard})`
    ).bind(activeIds, now - 7 * 86400),
  ])
  if (cleanup.some((result) => !result.success)) throw new Error('Notification cleanup failed')
  if (!monitors.length) return
  const suppressed = suppressedMonitors(config, now)
  const summaries = await getProbeSummaries(env, monitors, config.probes, now)
  const native = monitors.some((monitor) => !monitor.probes?.length)
    ? new CompactedMonitorStateWrapper(await getFromStore(env, 'state'))
    : null
  for (const monitor of monitors) {
    const options = { graceSeconds: monitor.notificationGracePeriodSeconds ?? (config.notification?.gracePeriod ?? 0)*60,
      skipReasonChanges: config.notification?.skipErrorChangeNotification ?? false,
      timeZone: config.notification?.timeZone, suppressed: suppressed.has(monitor.id), configGuard: snapshot.guard }
    const summary = summaries[monitor.id]
    if (summary) {
      const resumedAt = resumeAfter.get(monitor.id)
      if (resumedAt !== undefined && summary.probes.some(probe => probe.latest === null || probe.latest <= resumedAt)) continue
      if (summary.status !== 'up' && summary.status !== 'down') {
        await env.UPTIMEFLARE_D1.prepare(`UPDATE notification_observations SET status='up',down_since=NULL,observed_at=?,version=version+1 WHERE monitor_id=? AND notified=0 AND observed_at<? AND status NOT IN ('paused','awaiting') AND (${snapshot.guard})`).bind(now,monitor.id,now).run()
        continue
      }
      const reason = summary.probes
        .filter((probe) => probe.status === 'down')
        .map((probe) => `${probe.name}: ${probe.stage ?? 'unknown'}/${probe.code ?? 'unknown'}`)
        .join('; ')
      await queueNotification(env, monitor, summary.status, summary.latest ?? now, reason, now, {
        ...options, reasonKey: summary.probes.filter(probe => probe.status === 'down').map(probe => `${probe.id}:${probe.stage}/${probe.code}`).sort().join(';') })
    } else if (native && native.data.latency[monitor.id]?.time && native.incidentLen(monitor.id)) {
      const latest = native.getLastLatency(monitor.id)
      if (latest.time <= (resumeAfter.get(monitor.id) ?? -Infinity)) continue
      if (latest.time < now - getMonitorStaleAfterSeconds(monitor)) continue
      const incident = native.getIncident(monitor.id, native.incidentLen(monitor.id) - 1)
      await queueNotification(
        env,
        monitor,
        incident.end === null ? 'down' : 'up',
        latest.time,
        incident.end === null ? incident.error[incident.error.length - 1] ?? '' : '',
        now,
        options
      )
    }
  }
  await deliverNotifications(env, sourceConfig, now, send)
}
