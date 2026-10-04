import Head from 'next/head'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import { IconArrowLeft } from '@tabler/icons-react'
import {
  Alert,
  Button,
  Checkbox,
  Container,
  Group,
  MultiSelect,
  NumberInput,
  Paper,
  PasswordInput,
  Select,
  Stack,
  Tabs,
  Text,
  TextInput,
  Textarea,
  Title,
} from '@mantine/core'
import type { MonitorTarget, NotificationTemplate } from '@/types/config'
import type { StoredSettings } from '@/worker/src/settings'
import NotificationTemplateEditor, {
  type WebhookDraft,
} from '@/components/NotificationTemplateEditor'
import PageSettingsEditor from '@/components/PageSettingsEditor'
import MonitorGroupsEditor, { applyGroupDraftNames } from '@/components/MonitorGroupsEditor'
import MaintenancePlansEditor from '@/components/MaintenancePlansEditor'
import NotificationDefaultsEditor from '@/components/NotificationDefaultsEditor'
import { createInternalId } from '@/util/internal-id'
import {
  DEFAULT_MONITOR_INTERVAL_SECONDS,
  DEFAULT_MONITOR_TIMEOUT_MS,
  MAX_MONITOR_INTERVAL_SECONDS,
  MIN_MONITOR_INTERVAL_SECONDS,
  getMonitorIntervalSeconds,
} from '@/util/monitor-settings'

const probeName = (probe: Config['probes'][number], index: number) =>
  probe.name ||
  probe.defaultName ||
  (probe.id === 'cloudflare' ? 'Cloudflare' : `探针 ${index + 1}`)

// Repeated display names remain selectable without exposing internal identities.
function optionLabels<T extends { id: string }>(
  items: T[],
  name: (item: T, index: number) => string
) {
  const counts = new Map<string, number>()
  return items.map((item, index) => {
    const label = name(item, index)
    const count = (counts.get(label) ?? 0) + 1
    counts.set(label, count)
    return { value: item.id, label: count > 1 ? `${label}（${count}）` : label }
  })
}

type Config = StoredSettings & { probes: NonNullable<StoredSettings['probes']> }
async function api(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`/api/admin/${path}`, {
    method,
    credentials: 'same-origin',
    cache: 'no-store',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const result: any = await response.json()
  if (!response.ok) {
    const error = new Error(result.error ?? '请求失败') as Error & { status: number }
    error.status = response.status
    throw error
  }
  return result
}
export default function Admin() {
  const [config, setConfig] = useState<Config | null>(null)
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [advanced, setAdvanced] = useState<Record<string, string>>({})
  const [webhookDrafts, setWebhookDrafts] = useState<Record<string, WebhookDraft>>({})
  const [activeTab, setActiveTab] = useState<string | null>('monitors')
  const [groupDraftNames, setGroupDraftNames] = useState<Record<string, string>>({})
  const monitorOptions = optionLabels(
    config?.monitors ?? [],
    (monitor) => monitor.name || '未命名目标'
  )
  const load = async () => {
    const result = await api('config')
    setConfig(result)
    setAdvanced({})
    setWebhookDrafts({})
    setGroupDraftNames({})
  }
  useEffect(() => {
    load()
      .catch((e) => {
        if (e.status !== 401) setError(e.message)
      })
      .finally(() => setLoading(false))
  }, [])
  const action = async (fn: () => Promise<void>) => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await fn()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const updateMonitor = (index: number, patch: Partial<MonitorTarget>) => {
    setConfig(
      (old) =>
        old && {
          ...old,
          monitors: old.monitors.map((m, i) => (i === index ? { ...m, ...patch } : m)),
        }
    )
  }
  const updateOptionalMonitor = (
    index: number,
    field:
      | 'intervalSeconds'
      | 'timeout'
      | 'notificationGracePeriodSeconds'
      | 'certificateExpiryDays',
    value: string | number
  ) => {
    setConfig(
      (old) =>
        old && {
          ...old,
          monitors: old.monitors.map((monitor, monitorIndex) => {
            if (monitorIndex !== index) return monitor
            const updated = { ...monitor }
            if (value === '') delete updated[field]
            else updated[field] = Number(value)
            return updated
          }),
        }
    )
  }
  const save = async () => {
    if (!config) return
    const monitors = config.monitors.map((monitor) => {
      if (advanced[monitor.id] === undefined) return monitor
      let fields: any
      try {
        fields = JSON.parse(advanced[monitor.id])
      } catch {
        throw new Error(`${monitor.name} 的附加设置 JSON 无效`)
      }
      if (!fields || typeof fields !== 'object' || Array.isArray(fields))
        throw new Error('附加设置应为 JSON 对象')
      const { intervalSeconds: ignoredInterval, ...extraFields } = fields
      void ignoredInterval
      return {
        ...extraFields,
        id: monitor.id,
        name: monitor.name,
        target: monitor.target,
        method: monitor.method,
        probes: monitor.probes,
        intervalSeconds: monitor.intervalSeconds,
        timeout: monitor.timeout,
        notificationTemplateId: monitor.notificationTemplateId,
        notificationGracePeriodSeconds: monitor.notificationGracePeriodSeconds,
        certificateExpiryDays: monitor.certificateExpiryDays,
        icmpProxyURL: monitor.icmpProxyURL,
        checkProxy: monitor.checkProxy,
        checkProxyFallback: monitor.checkProxyFallback,
      }
    })
    const notificationTemplates = (config.notificationTemplates ?? []).map((template) => {
      const draft = webhookDrafts[template.id]
      try {
        return {
          ...template,
          webhook: {
            ...template.webhook,
            headers:
              draft?.headers === undefined ? template.webhook.headers : JSON.parse(draft.headers),
            payload:
              draft?.payload === undefined ? template.webhook.payload : JSON.parse(draft.payload),
          },
        }
      } catch {
        throw new Error(`${template.name} 的推送配置 JSON 无效`)
      }
    })
    const page = {
      ...config.page,
      group: applyGroupDraftNames(config.page?.group ?? {}, groupDraftNames),
    }
    const saved = await api('config', 'PUT', { ...config, monitors, notificationTemplates, page })
    setConfig(saved)
    setAdvanced({})
    setWebhookDrafts({})
    setGroupDraftNames({})
    setMessage('已保存到 D1。探针通常在 5 分钟内获取新配置。')
  }
  return (
    <>
      <Head>
        <title>配置管理 · UptimeFlare Distributed</title>
        <meta name="robots" content="noindex,nofollow" />
      </Head>
      <Container size="md" py="xl">
        <Group justify="space-between" mb="lg">
          <Title order={2}>配置管理</Title>
          <Group gap="xs">
            {config && (
              <Button
                variant="subtle"
                disabled={busy}
                onClick={() =>
                  void action(async () => {
                    await api('logout', 'POST')
                    setConfig(null)
                  })
                }
              >
                退出登录
              </Button>
            )}
            <Button
              component={Link}
              href="/"
              variant="default"
              leftSection={<IconArrowLeft size={16} />}
            >
              返回
            </Button>
          </Group>
        </Group>
        {error && (
          <Alert color="red" mb="md">
            {error}
          </Alert>
        )}
        {message && (
          <Alert color="green" mb="md">
            {message}
          </Alert>
        )}
        {loading ? (
          <Text>正在检查登录状态…</Text>
        ) : !config ? (
          <Paper withBorder p="lg" maw={440} mx="auto">
            <form
              onSubmit={(e) => {
                e.preventDefault()
                void action(async () => {
                  await api('login', 'POST', { password })
                  setPassword('')
                  await load()
                })
              }}
            >
              <Stack>
                <Title order={3}>管理员登录</Title>
                <PasswordInput
                  label="管理密码"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.currentTarget.value)}
                />
                <Button type="submit" loading={busy}>
                  登录
                </Button>
              </Stack>
            </form>
          </Paper>
        ) : (
          <Stack>
            <Tabs value={activeTab} onChange={setActiveTab} keepMounted={false}>
              <Tabs.List grow aria-label="配置板块">
                <Tabs.Tab value="monitors">监控目标</Tabs.Tab>
                <Tabs.Tab value="probes">探针</Tabs.Tab>
                <Tabs.Tab value="notifications">通知</Tabs.Tab>
                <Tabs.Tab value="groups">分组</Tabs.Tab>
                <Tabs.Tab value="maintenances">维护计划</Tabs.Tab>
                <Tabs.Tab value="page">页面设置</Tabs.Tab>
              </Tabs.List>
              <Tabs.Panel value="groups" pt="md">
                <MonitorGroupsEditor
                  value={config.page?.group ?? {}}
                  monitorOptions={monitorOptions}
                  draftNames={groupDraftNames}
                  onChange={(group) => {
                    setConfig({ ...config, page: { ...config.page, group } })
                    setGroupDraftNames((old) =>
                      Object.fromEntries(
                        Object.entries(old).filter(([key]) => Object.hasOwn(group, key))
                      )
                    )
                  }}
                  onDraftChange={(key, name) =>
                    setGroupDraftNames((old) => ({ ...old, [key]: name }))
                  }
                />
              </Tabs.Panel>
              <Tabs.Panel value="maintenances" pt="md">
                <MaintenancePlansEditor
                  value={config.maintenances ?? []}
                  monitorOptions={monitorOptions}
                  onChange={(maintenances) => setConfig({ ...config, maintenances })}
                />
              </Tabs.Panel>
              <Tabs.Panel value="page" pt="md">
                <PageSettingsEditor
                  value={config.page ?? {}}
                  onChange={(page) => setConfig({ ...config, page })}
                />
              </Tabs.Panel>
              <Tabs.Panel value="probes" pt="md">
                <Paper withBorder p="md">
                  <Stack>
                    <Title order={3}>探针</Title>
                    <Text size="sm" c="dimmed">
                      Cloudflare 为内置探针，无需令牌。独立探针的默认名称为公网 IP 归属地与 ASN。
                      名称留空使用自动命名；手动填写可覆盖。新增独立探针需要先配置服务端令牌。
                    </Text>
                    {config.probes.map((probe, index) => {
                      const assigned = config.monitors.filter(
                        (monitor) => monitor.probes?.includes(probe.id)
                      )
                      return (
                        <Paper key={probe.id} withBorder p="sm">
                          <Group align="end" grow>
                            <TextInput
                              label="显示名称"
                              value={probe.name ?? ''}
                              placeholder={probe.defaultName ?? probeName(probe, index)}
                              onChange={(e) => {
                                const name = e.currentTarget.value
                                setConfig({
                                  ...config,
                                  probes: config.probes.map((p, i) =>
                                    i === index ? { ...p, name } : p
                                  ),
                                })
                              }}
                            />
                            <TextInput
                              label="地区 / 运营商"
                              value={probe.location ?? ''}
                              placeholder={probe.defaultLocation ?? ''}
                              onChange={(e) => {
                                const location = e.currentTarget.value
                                setConfig({
                                  ...config,
                                  probes: config.probes.map((p, i) =>
                                    i === index ? { ...p, location } : p
                                  ),
                                })
                              }}
                            />
                          </Group>
                          <Group justify="space-between" mt="sm" mb="xs">
                            <Text size="sm" fw={500}>
                              执行目标（{assigned.length}）
                            </Text>
                            <Button
                              size="xs"
                              variant="subtle"
                              onClick={() => setActiveTab('monitors')}
                            >
                              配置目标
                            </Button>
                          </Group>
                          {assigned.length ? (
                            <Stack gap={4}>
                              {assigned.map((monitor) => (
                                <Group key={monitor.id} justify="space-between" gap="xs">
                                  <Text size="sm">{monitor.name || '未命名目标'}</Text>
                                  <Text size="xs" c="dimmed">
                                    每 {getMonitorIntervalSeconds(monitor)} 秒 · 超时{' '}
                                    {(monitor.timeout ?? DEFAULT_MONITOR_TIMEOUT_MS) / 1000} 秒
                                  </Text>
                                </Group>
                              ))}
                            </Stack>
                          ) : (
                            <Text size="sm" c="dimmed">
                              尚未分配监控目标
                            </Text>
                          )}
                        </Paper>
                      )
                    })}
                    <Text size="xs" c="dimmed">
                      检测设置由监控目标统一配置，已保存的变更会自动下发到执行探针。
                    </Text>
                  </Stack>
                </Paper>
              </Tabs.Panel>
              <Tabs.Panel value="notifications" pt="md">
                <Stack>
                  <NotificationDefaultsEditor
                    value={config.notification ?? {}}
                    monitorOptions={monitorOptions}
                    onChange={(notification) => setConfig({ ...config, notification })}
                  />
                  <Group justify="space-between">
                    <Title order={3}>通知模板</Title>
                    <Button
                      variant="light"
                      onClick={() =>
                        setConfig({
                          ...config,
                          notificationTemplates: [
                            ...(config.notificationTemplates ?? []),
                            {
                              id: createInternalId(
                                'template',
                                new Set(
                                  (config.notificationTemplates ?? []).map(
                                    (template) => template.id
                                  )
                                )
                              ),
                              name: '新模板',
                              type: 'webhook',
                              webhook: {
                                url: 'https://',
                                method: 'POST',
                                payloadType: 'json',
                                payload: { text: '$MSG' },
                                timeout: 5000,
                              },
                            },
                          ],
                        })
                      }
                    >
                      添加模板
                    </Button>
                  </Group>
                  {(config.notificationTemplates ?? []).map((template, index) => (
                    <NotificationTemplateEditor
                      key={template.id}
                      template={template}
                      draft={webhookDrafts[template.id]}
                      onChange={(patch: Partial<NotificationTemplate>) =>
                        setConfig({
                          ...config,
                          notificationTemplates: (config.notificationTemplates ?? []).map(
                            (item, itemIndex) =>
                              itemIndex === index ? { ...item, ...patch } : item
                          ),
                        })
                      }
                      onDraftChange={(patch) =>
                        setWebhookDrafts((old) => ({
                          ...old,
                          [template.id]: { ...old[template.id], ...patch },
                        }))
                      }
                      onRemove={() => {
                        if (window.confirm('删除此模板并关闭使用它的目标通知？'))
                          setConfig({
                            ...config,
                            notificationTemplates: (config.notificationTemplates ?? []).filter(
                              (item) => item.id !== template.id
                            ),
                            monitors: config.monitors.map((monitor) =>
                              monitor.notificationTemplateId === template.id
                                ? { ...monitor, notificationTemplateId: undefined }
                                : monitor
                            ),
                          })
                      }}
                    />
                  ))}
                </Stack>
              </Tabs.Panel>
              <Tabs.Panel value="monitors" pt="md">
                <Stack>
                  <Group justify="space-between">
                    <Title order={3}>监控目标</Title>
                    <Button
                      variant="light"
                      onClick={() =>
                        setConfig({
                          ...config,
                          monitors: [
                            ...config.monitors,
                            {
                              id: createInternalId(
                                'monitor',
                                new Set(config.monitors.map((monitor) => monitor.id))
                              ),
                              name: '新目标',
                              target: 'https://',
                              method: 'GET',
                              probes: config.probes.map((p) => p.id),
                            },
                          ],
                        })
                      }
                    >
                      添加目标
                    </Button>
                  </Group>
                  {config.monitors.map((monitor, index) => {
                    const {
                      id,
                      name,
                      target,
                      method,
                      probes,
                      intervalSeconds,
                      timeout,
                      notificationTemplateId,
                      notificationGracePeriodSeconds,
                      certificateExpiryDays,
                      icmpProxyURL,
                      checkProxy,
                      checkProxyFallback,
                      ...extras
                    } = monitor
                    return (
                      <Paper withBorder p="md" key={id}>
                        <Stack>
                          <Group justify="space-between">
                            <Text fw={600}>{name}</Text>
                            <Button
                              color="red"
                              variant="subtle"
                              onClick={() => {
                                if (window.confirm('确认删除此目标及它的分组、维护关联？'))
                                  setConfig({
                                    ...config,
                                    monitors: config.monitors.filter((_, i) => i !== index),
                                    page: {
                                      ...config.page,
                                      group: Object.fromEntries(
                                        Object.entries(config.page?.group ?? {}).map(
                                          ([group, targets]) => [
                                            group,
                                            targets.filter((targetId) => targetId !== id),
                                          ]
                                        )
                                      ),
                                    },
                                    maintenances: config.maintenances
                                      ?.filter(
                                        (maintenance) =>
                                          !maintenance.monitors?.includes(id) ||
                                          maintenance.monitors.length > 1
                                      )
                                      .map((maintenance) => ({
                                        ...maintenance,
                                        monitors: maintenance.monitors?.filter(
                                          (targetId) => targetId !== id
                                        ),
                                      })),
                                    notification: {
                                      ...config.notification,
                                      skipNotificationIds:
                                        config.notification?.skipNotificationIds?.filter(
                                          (targetId) => targetId !== id
                                        ),
                                    },
                                  })
                              }}
                            >
                              删除
                            </Button>
                          </Group>
                          <Group grow>
                            <TextInput
                              label="名称"
                              value={name}
                              onChange={(e) =>
                                updateMonitor(index, { name: e.currentTarget.value })
                              }
                            />
                          </Group>
                          <Group grow>
                            <Select
                              label="检测方法"
                              data={[
                                'GET',
                                'HEAD',
                                'POST',
                                'PUT',
                                'PATCH',
                                'DELETE',
                                'OPTIONS',
                                'TCP_PING',
                                'SSL_CERT',
                                'ICMP_PING',
                              ]}
                              value={method}
                              onChange={(v) => updateMonitor(index, { method: v ?? 'GET' })}
                            />
                          </Group>
                          <Group grow>
                            <NumberInput
                              label="检测间隔（秒，可选）"
                              min={MIN_MONITOR_INTERVAL_SECONDS}
                              max={MAX_MONITOR_INTERVAL_SECONDS}
                              allowDecimal={false}
                              allowNegative={false}
                              placeholder={`${DEFAULT_MONITOR_INTERVAL_SECONDS}（5 分钟）`}
                              value={intervalSeconds ?? ''}
                              onChange={(value) =>
                                updateOptionalMonitor(index, 'intervalSeconds', value)
                              }
                            />
                            <NumberInput
                              label="超时（毫秒，可选）"
                              min={1}
                              max={120000}
                              allowDecimal={false}
                              allowNegative={false}
                              placeholder={`${DEFAULT_MONITOR_TIMEOUT_MS}（5 秒）`}
                              value={timeout ?? ''}
                              onChange={(value) => updateOptionalMonitor(index, 'timeout', value)}
                            />
                          </Group>
                          <TextInput
                            label={
                              method === 'TCP_PING'
                                ? '目标 host:port'
                                : method === 'ICMP_PING'
                                ? '目标主机 / IP'
                                : method === 'SSL_CERT'
                                ? '目标 HTTPS URL'
                                : '目标 URL'
                            }
                            value={target}
                            onChange={(e) =>
                              updateMonitor(index, { target: e.currentTarget.value })
                            }
                          />
                          {method === 'SSL_CERT' && (
                            <NumberInput
                              label="证书到期阈值（天，可选）"
                              placeholder="14"
                              min={0}
                              max={365}
                              allowDecimal={false}
                              allowNegative={false}
                              value={certificateExpiryDays ?? ''}
                              onChange={(value) =>
                                updateOptionalMonitor(index, 'certificateExpiryDays', value)
                              }
                            />
                          )}
                          {method === 'ICMP_PING' && (
                            <TextInput
                              label="ICMP 代理地址（可选）"
                              placeholder="https://"
                              value={icmpProxyURL ?? ''}
                              onChange={(event) =>
                                updateMonitor(index, {
                                  icmpProxyURL: event.currentTarget.value || undefined,
                                })
                              }
                            />
                          )}
                          <MultiSelect
                            label="执行探针"
                            data={optionLabels(config.probes, probeName)}
                            value={probes ?? []}
                            onChange={(v) => updateMonitor(index, { probes: v })}
                          />
                          {probes?.includes('cloudflare') && method === 'SSL_CERT' && (
                            <Text size="xs" c="dimmed">
                              Cloudflare 需要 HTTPS 检测代理；也可选择 Go 探针直接检查证书。
                            </Text>
                          )}
                          {probes?.includes('cloudflare') && method === 'ICMP_PING' && (
                            <Text size="xs" c="dimmed">
                              Cloudflare 需要 ICMP 代理或 globalping:// 检测代理。
                            </Text>
                          )}
                          <Select
                            label="通知模板"
                            placeholder="关闭通知"
                            clearable
                            data={optionLabels(
                              config.notificationTemplates ?? [],
                              (template) => template.name || '未命名模板'
                            )}
                            value={notificationTemplateId ?? null}
                            onChange={(value) =>
                              updateMonitor(index, { notificationTemplateId: value ?? undefined })
                            }
                          />
                          <NumberInput
                            label="通知宽限期（秒，可选）"
                            description="留空使用通知中的全局设置"
                            placeholder={String((config.notification?.gracePeriod ?? 0) * 60)}
                            min={0}
                            max={86400}
                            allowDecimal={false}
                            allowNegative={false}
                            value={notificationGracePeriodSeconds ?? ''}
                            onChange={(value) =>
                              updateOptionalMonitor(index, 'notificationGracePeriodSeconds', value)
                            }
                          />
                          <details>
                            <summary style={{ cursor: 'pointer' }}>附加设置</summary>
                            <TextInput
                              mt="sm"
                              label="检测代理（可选）"
                              placeholder="https:// 或 globalping://"
                              value={checkProxy ?? ''}
                              onChange={(event) =>
                                updateMonitor(index, {
                                  checkProxy: event.currentTarget.value || undefined,
                                })
                              }
                            />
                            <Checkbox
                              mt="sm"
                              label="代理不可用时尝试直接检测"
                              checked={checkProxyFallback ?? false}
                              onChange={(event) =>
                                updateMonitor(index, {
                                  checkProxyFallback: event.currentTarget.checked,
                                })
                              }
                            />
                            <Textarea
                              mt="sm"
                              label="JSON"
                              autosize
                              minRows={4}
                              maxRows={16}
                              value={advanced[id] ?? JSON.stringify(extras, null, 2)}
                              onChange={(e) =>
                                setAdvanced({ ...advanced, [id]: e.currentTarget.value })
                              }
                            />
                          </details>
                        </Stack>
                      </Paper>
                    )
                  })}
                </Stack>
              </Tabs.Panel>
            </Tabs>
            <Button size="md" loading={busy} onClick={() => void action(save)}>
              保存配置
            </Button>
          </Stack>
        )}
      </Container>
    </>
  )
}
