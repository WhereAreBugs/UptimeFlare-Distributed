import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Group,
  MultiSelect,
  Paper,
  Stack,
  Text,
  TextInput,
  Textarea,
  Title,
} from '@mantine/core'
import {
  managementTokenExpiry,
  managementTokenGroups,
  managementTokenStatus,
} from '@/util/management-token-ui'
import type {
  ManagementPermission,
  ManagementTokenCreated,
  ManagementTokenList,
} from '@/types/management'

type AdminRequest = (path: string, method?: string, body?: unknown) => Promise<any>
const formatTime = (time: number) => new Date(time * 1000).toLocaleString()

export default function ManagementTokenEditor({
  request,
  refreshVersion,
  disabled = false,
  onBusyChange,
  onOpenGroups,
}: {
  request: AdminRequest
  refreshVersion: number
  disabled?: boolean
  onBusyChange: (busy: boolean) => void
  onOpenGroups: () => void
}) {
  const [data, setData] = useState<ManagementTokenList | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [name, setName] = useState('')
  const [groupIds, setGroupIds] = useState<string[]>([])
  const [permissions, setPermissions] = useState<ManagementPermission[]>(['query', 'control'])
  const [expires, setExpires] = useState('')
  const [secret, setSecret] = useState('')
  const [secretEntryId, setSecretEntryId] = useState('')
  const [copied, setCopied] = useState(false)
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  const alive = useRef(false)
  const generation = useRef(0)
  useEffect(() => {
    alive.current = true
    const timer = window.setInterval(() => setNow(Math.floor(Date.now() / 1000)), 60000)
    return () => {
      alive.current = false
      window.clearInterval(timer)
    }
  }, [])
  const refresh = useCallback(async () => {
    const current = ++generation.current
    setLoading(true)
    try {
      const result: ManagementTokenList = await request('tokens')
      if (!alive.current || current !== generation.current) return
      setData(result)
      setNow(Math.floor(Date.now() / 1000))
      const allowed = new Set(result.groups.map((group) => group.id))
      setGroupIds((selected) => selected.filter((id) => allowed.has(id)))
    } finally {
      if (alive.current && current === generation.current) setLoading(false)
    }
  }, [request])
  useEffect(() => {
    refresh().catch((failure) => {
      if (alive.current) setError(failure instanceof Error ? failure.message : 'Token 列表加载失败')
    })
  }, [refresh, refreshVersion])
  const run = async (operation: () => Promise<void>) => {
    setBusy(true)
    onBusyChange(true)
    setError('')
    setMessage('')
    try {
      await operation()
    } catch (failure) {
      if (alive.current) setError(failure instanceof Error ? failure.message : '请求失败')
    } finally {
      if (alive.current) setBusy(false)
      onBusyChange(false)
    }
  }
  const create = async () => {
    const result: ManagementTokenCreated = await request('tokens', 'POST', {
      name: name.trim(),
      groupIds,
      permissions,
      expiresAt: managementTokenExpiry(expires),
    })
    if (!alive.current) return
    setSecret(result.token)
    setSecretEntryId(result.entry.id)
    setCopied(false)
    setName('')
    setGroupIds([])
    setPermissions(['query', 'control'])
    setExpires('')
    setMessage('Token 已创建并立即生效。')
    // A failed list refresh must not hide the only returned copy of the new token.
    await refresh()
  }
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(secret)
      if (alive.current) setCopied(true)
    } catch {
      if (alive.current) setError('复制失败，请手动复制 Token。')
    }
  }
  const blocked = disabled || busy
  const activeCount =
    data?.tokens.filter((token) => managementTokenStatus(token, now) === 'active').length ?? 0
  return (
    <Stack>
      <Title order={3}>管理 Token</Title>
      <Text size="sm" c="dimmed">
        创建和撤销立即生效，无需保存配置。授权只使用已保存的分组。
      </Text>
      {error && (
        <Alert color="red" role="alert">
          {error}
        </Alert>
      )}
      {message && (
        <Text size="sm" c="green" role="status">
          {message}
        </Text>
      )}
      {secret && (
        <Paper withBorder p="md">
          <Stack gap="sm">
            <Text fw={600}>Token 仅在此显示一次</Text>
            <Textarea
              aria-label="新建管理 Token"
              readOnly
              value={secret}
              autosize
              minRows={2}
              maxRows={4}
              styles={{ input: { overflowWrap: 'anywhere' } }}
            />
            <Text size="xs" c="dimmed">
              请保存到可信位置。关闭或离开此标签页后无法再次查看。
            </Text>
            <Group gap="xs">
              <Button disabled={blocked} onClick={() => void copy()}>
                {copied ? '已复制' : '复制'}
              </Button>
              <Button
                variant="default"
                disabled={blocked}
                onClick={() => {
                  setSecret('')
                  setSecretEntryId('')
                  setCopied(false)
                }}
              >
                关闭
              </Button>
            </Group>
          </Stack>
        </Paper>
      )}
      <Paper withBorder p="md">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            if (!blocked && !loading && !secret) void run(create)
          }}
        >
          <Stack>
            <TextInput
              label="名称"
              placeholder="例如：自动化管理"
              value={name}
              maxLength={80}
              required
              disabled={blocked || !!secret}
              onChange={(event) => setName(event.currentTarget.value)}
            />
            <MultiSelect
              label="授权分组"
              data={(data?.groups ?? []).map((group) => ({
                value: group.id,
                label: `${group.name}（${group.targetCount} 个目标）`,
              }))}
              value={groupIds}
              searchable
              required
              disabled={blocked || loading || !!secret}
              onChange={setGroupIds}
            />
            {!loading && data?.groups.length === 0 && (
              <Group gap="xs">
                <Text size="sm" c="dimmed">
                  请先保存需要授权的分组。
                </Text>
                <Button variant="subtle" size="xs" onClick={onOpenGroups}>
                  前往分组
                </Button>
              </Group>
            )}
            <Group gap="lg">
              <Checkbox
                label="查询状态"
                checked={permissions.includes('query')}
                disabled={blocked || !!secret}
                onChange={(event) => {
                  const checked = event.currentTarget.checked
                  setPermissions((current) =>
                    checked ? [...current, 'query'] : current.filter((value) => value !== 'query')
                  )
                }}
              />
              <Checkbox
                label="控制暂停 / 恢复"
                checked={permissions.includes('control')}
                disabled={blocked || !!secret}
                onChange={(event) => {
                  const checked = event.currentTarget.checked
                  setPermissions((current) =>
                    checked
                      ? [...current, 'control']
                      : current.filter((value) => value !== 'control')
                  )
                }}
              />
            </Group>
            <TextInput
              type="datetime-local"
              label="到期时间（可选，本地时间）"
              value={expires}
              disabled={blocked || !!secret}
              onChange={(event) => setExpires(event.currentTarget.value)}
            />
            <Button
              type="submit"
              loading={busy}
              disabled={
                disabled ||
                loading ||
                !name.trim() ||
                !groupIds.length ||
                !permissions.length ||
                !!secret ||
                activeCount >= 100
              }
            >
              创建 Token
            </Button>
            {activeCount >= 100 && (
              <Text size="sm" c="dimmed">
                最多保留 100 个有效 Token，请先撤销不再使用的 Token。
              </Text>
            )}
          </Stack>
        </form>
      </Paper>
      <Text fw={600}>已有 Token（{data?.tokens.length ?? 0}）</Text>
      {loading && (
        <Text size="sm" c="dimmed">
          正在加载…
        </Text>
      )}
      {!loading && data?.tokens.length === 0 && (
        <Text size="sm" c="dimmed">
          尚未创建 Token。
        </Text>
      )}
      {data?.tokens.map((token) => {
        const status = managementTokenStatus(token, now)
        const groups = managementTokenGroups(token, data.groups)
        return (
          <Paper key={token.id} withBorder p="md">
            <Stack gap="xs">
              <Group justify="space-between" align="start">
                <Group gap="xs" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
                  <Text fw={600}>{token.name}</Text>
                  <Badge color={status === 'active' ? 'green' : 'gray'}>
                    {status === 'active' ? '有效' : status === 'revoked' ? '已撤销' : '已过期'}
                  </Badge>
                </Group>
                {token.revokedAt === null && (
                  <Button
                    size="xs"
                    variant="subtle"
                    color="red"
                    disabled={blocked}
                    onClick={() => {
                      if (window.confirm(`撤销“${token.name}”？使用它的请求将立即失效。`))
                        void run(async () => {
                          await request(`tokens/${encodeURIComponent(token.id)}`, 'DELETE')
                          if (token.id === secretEntryId) {
                            setSecret('')
                            setSecretEntryId('')
                          }
                          setMessage('Token 已撤销并立即失效。')
                          await refresh()
                        })
                    }}
                  >
                    撤销
                  </Button>
                )}
              </Group>
              <Text size="sm" style={{ overflowWrap: 'anywhere' }}>
                分组：{groups.names.join('、') || '无可用分组'}
                {groups.deleted > 0 && ` · ${groups.deleted} 个分组已删除`}
              </Text>
              <Text size="sm">
                权限：
                {token.permissions
                  .map((permission) => (permission === 'query' ? '查询状态' : '控制暂停 / 恢复'))
                  .join('、')}
              </Text>
              <Text size="xs" c="dimmed">
                创建：{formatTime(token.createdAt)} · 到期：
                {token.expiresAt === null ? '无' : formatTime(token.expiresAt)}
                {token.revokedAt !== null && ` · 撤销：${formatTime(token.revokedAt)}`}
              </Text>
            </Stack>
          </Paper>
        )
      })}
    </Stack>
  )
}
