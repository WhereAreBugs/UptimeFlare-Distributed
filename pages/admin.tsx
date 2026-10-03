import Head from 'next/head'
import Link from 'next/link'
import { useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Container,
  Group,
  MultiSelect,
  NumberInput,
  Paper,
  PasswordInput,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
} from '@mantine/core'
import type { MonitorTarget } from '@/types/config'
import type { StoredSettings } from '@/worker/src/settings'

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
  const load = async () => {
    const result = await api('config')
    setConfig(result)
    setAdvanced({})
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
  const save = async () => {
    if (!config) return
    const monitors = config.monitors.map((monitor) => {
      if (advanced[monitor.id] === undefined) return monitor
      let fields: any
      try {
        fields = JSON.parse(advanced[monitor.id])
      } catch {
        throw new Error(`${monitor.name} 的高级配置 JSON 无效`)
      }
      if (!fields || typeof fields !== 'object' || Array.isArray(fields))
        throw new Error('高级配置应为 JSON 对象')
      return {
        ...fields,
        id: monitor.id,
        name: monitor.name,
        target: monitor.target,
        method: monitor.method,
        probes: monitor.probes,
        timeout: monitor.timeout,
      }
    })
    const saved = await api('config', 'PUT', { ...config, monitors })
    setConfig(saved)
    setAdvanced({})
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
          <Link href="/">返回公开状态页</Link>
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
            <Group justify="space-between">
              <Text c="dimmed">配置版本 {config.revision}</Text>
              <Group>
                <Button variant="default" disabled={busy} onClick={() => void action(load)}>
                  重新加载
                </Button>
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
              </Group>
            </Group>
            <Paper withBorder p="md">
              <Stack>
                <Title order={3}>探针</Title>
                <Text size="sm" c="dimmed">
                  Cloudflare 为内置探针，无需令牌。独立探针的默认名称为公网 IP 归属地与 ASN。
                  名称留空使用自动命名；手动填写可覆盖。新增独立探针需要先配置服务端令牌。
                </Text>
                {config.probes.map((probe, index) => (
                  <Group key={probe.id} align="end" grow>
                    <TextInput label="探针 ID" value={probe.id} readOnly />
                    <TextInput
                      label="显示名称"
                      value={probe.name ?? ''}
                      placeholder={probe.defaultName ?? probe.id}
                      description={`自动名称：${probe.defaultName ?? probe.id}`}
                      onChange={(e) => {
                        const name = e.currentTarget.value
                        setConfig({
                          ...config,
                          probes: config.probes.map((p, i) => (i === index ? { ...p, name } : p)),
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
                ))}
                <NumberInput
                  label="无新结果多久后显示探针失联（秒）"
                  min={300}
                  max={86400}
                  value={config.probeStaleAfterSeconds ?? 900}
                  onChange={(v) => setConfig({ ...config, probeStaleAfterSeconds: Number(v) })}
                />
              </Stack>
            </Paper>
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
                        id: `monitor-${crypto.randomUUID().slice(0, 8)}`,
                        name: '新目标',
                        target: 'https://',
                        method: 'GET',
                        probes: config.probes.map((p) => p.id),
                        timeout: 10000,
                      },
                    ],
                  })
                }
              >
                添加目标
              </Button>
            </Group>
            <Text size="sm" c="dimmed">
              取消目标或探针分配前，请先让相关探针补传完本地积压。
            </Text>
            {config.monitors.map((monitor, index) => {
              const { id, name, target, method, probes, timeout, ...extras } = monitor
              return (
                <Paper withBorder p="md" key={id}>
                  <Stack>
                    <Group justify="space-between">
                      <Text fw={600}>{name}</Text>
                      <Button
                        color="red"
                        variant="subtle"
                        onClick={() => {
                          if (window.confirm('确认删除此目标？请先确认探针积压已补传完成。'))
                            setConfig({
                              ...config,
                              monitors: config.monitors.filter((_, i) => i !== index),
                            })
                        }}
                      >
                        删除
                      </Button>
                    </Group>
                    <Group grow>
                      <TextInput label="目标 ID（保留历史）" value={id} readOnly />
                      <TextInput
                        label="名称"
                        value={name}
                        onChange={(e) => updateMonitor(index, { name: e.currentTarget.value })}
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
                        ]}
                        value={method}
                        onChange={(v) => updateMonitor(index, { method: v ?? 'GET' })}
                      />
                      <NumberInput
                        label="超时（毫秒）"
                        min={1}
                        max={120000}
                        value={timeout ?? 10000}
                        onChange={(v) => updateMonitor(index, { timeout: Number(v) })}
                      />
                    </Group>
                    <TextInput
                      label={method === 'TCP_PING' ? '目标 host:port' : '目标 URL'}
                      value={target}
                      onChange={(e) => updateMonitor(index, { target: e.currentTarget.value })}
                    />
                    <MultiSelect
                      label="执行探针"
                      data={config.probes.map((p) => ({
                        value: p.id,
                        label: p.name || p.defaultName || p.id,
                      }))}
                      value={probes ?? []}
                      onChange={(v) => updateMonitor(index, { probes: v })}
                    />
                    <details>
                      <summary style={{ cursor: 'pointer' }}>
                        高级配置：状态码、关键词、请求头和请求体
                      </summary>
                      <Textarea
                        mt="sm"
                        label="JSON"
                        autosize
                        minRows={4}
                        maxRows={16}
                        value={advanced[id] ?? JSON.stringify(extras, null, 2)}
                        onChange={(e) => setAdvanced({ ...advanced, [id]: e.currentTarget.value })}
                      />
                      <Text size="xs" c="dimmed" mt="xs">
                        例如 {`{"expectedCodes":[200],"responseKeyword":"OK"}`}
                        。鉴权头仅在管理员接口及分配的探针中可见。
                      </Text>
                    </details>
                  </Stack>
                </Paper>
              )
            })}
            <Button size="md" loading={busy} onClick={() => void action(save)}>
              保存配置
            </Button>
          </Stack>
        )}
      </Container>
    </>
  )
}
