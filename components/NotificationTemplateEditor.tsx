import {
  Badge,
  Button,
  Group,
  NumberInput,
  Paper,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core'
import type { NotificationTemplate, SingleWebhook } from '@/types/config'

export type WebhookDraft = { headers?: string; payload?: string }

export default function NotificationTemplateEditor({
  template,
  draft,
  onChange,
  onDraftChange,
  onRemove,
}: {
  template: NotificationTemplate
  draft?: WebhookDraft
  onChange: (patch: Partial<NotificationTemplate>) => void
  onDraftChange: (patch: WebhookDraft) => void
  onRemove: () => void
}) {
  const webhook = template.webhook
  const update = (patch: Partial<SingleWebhook>) => onChange({ webhook: { ...webhook, ...patch } })
  return (
    <Paper withBorder p="md">
      <Stack gap="sm">
        <Group justify="space-between">
          <Group gap="xs">
            <Text fw={600}>{template.name}</Text>
            <Badge variant="light">Webhook</Badge>
          </Group>
          <Button color="red" variant="subtle" onClick={onRemove}>
            删除模板
          </Button>
        </Group>
        <TextInput
          label="模板名称"
          value={template.name}
          onChange={(event) => onChange({ name: event.currentTarget.value })}
        />
        <TextInput
          label="推送地址"
          placeholder="https://"
          value={webhook.url}
          onChange={(event) => update({ url: event.currentTarget.value })}
        />
        <Group grow>
          <Select
            label="请求方法"
            value={webhook.method ?? 'POST'}
            data={['GET', 'POST', 'PUT', 'PATCH']}
            onChange={(value) =>
              update({
                method: value as SingleWebhook['method'],
                ...(value === 'GET' && { payloadType: 'param' }),
              })
            }
          />
          <Select
            label="参数格式"
            value={webhook.payloadType}
            data={
              webhook.method === 'GET'
                ? [{ value: 'param', label: 'URL 查询参数' }]
                : [
                    { value: 'json', label: 'JSON' },
                    { value: 'param', label: 'URL 查询参数' },
                    { value: 'x-www-form-urlencoded', label: '表单' },
                  ]
            }
            onChange={(value) => update({ payloadType: value as SingleWebhook['payloadType'] })}
          />
          <NumberInput
            label="推送超时（毫秒）"
            min={1}
            max={30000}
            value={webhook.timeout ?? 5000}
            onChange={(value) => update({ timeout: Number(value) })}
          />
        </Group>
        <details>
          <summary style={{ cursor: 'pointer' }}>请求头</summary>
          <Textarea
            mt="sm"
            label="请求头（JSON）"
            autosize
            minRows={2}
            maxRows={8}
            value={draft?.headers ?? JSON.stringify(webhook.headers ?? {}, null, 2)}
            onChange={(event) => onDraftChange({ headers: event.currentTarget.value })}
          />
        </details>
        <Textarea
          label="通知正文（JSON）"
          autosize
          minRows={3}
          maxRows={12}
          value={draft?.payload ?? JSON.stringify(webhook.payload, null, 2)}
          onChange={(event) => onDraftChange({ payload: event.currentTarget.value })}
        />
        <Text size="xs" c="dimmed">
          可用变量：$MSG（通知内容）、$MONITOR（目标名称）、$STATUS（down/up）、$TIME（UTC
          时间）、$REASON（失败阶段）、$DURATION（故障秒数）。
        </Text>
      </Stack>
    </Paper>
  )
}
