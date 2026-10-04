import { Button, Checkbox, Group, Paper, Stack, Text, TextInput, Textarea } from '@mantine/core'
import type { PageConfig, PageConfigLink } from '@/types/config'

export default function PageSettingsEditor({
  value,
  onChange,
}: {
  value: PageConfig
  onChange: (value: PageConfig) => void
}) {
  const stringField = (field: 'title' | 'logo' | 'favicon' | 'customFooter', text: string) => {
    const next = { ...value }
    if (text === '') delete next[field]
    else next[field] = text
    onChange(next)
  }
  const updateLink = (index: number, patch: Partial<PageConfigLink>) =>
    onChange({
      ...value,
      links: (value.links ?? []).map((link, item) =>
        item === index ? { ...link, ...patch } : link
      ),
    })
  const moveLink = (index: number, direction: number) => {
    const links = [...(value.links ?? [])]
    ;[links[index], links[index + direction]] = [links[index + direction], links[index]]
    onChange({ ...value, links })
  }
  return (
    <Stack>
      <Paper withBorder p="md">
        <Stack>
          <TextInput
            label="页面标题"
            placeholder="UptimeFlare"
            value={value.title ?? ''}
            onChange={(event) => stringField('title', event.currentTarget.value)}
          />
          <TextInput
            label="Logo 地址"
            placeholder="/brand/status-suzume.webp"
            value={value.logo ?? ''}
            onChange={(event) => stringField('logo', event.currentTarget.value)}
          />
          <TextInput
            label="图标地址"
            placeholder="/favicon.png"
            value={value.favicon ?? ''}
            onChange={(event) => stringField('favicon', event.currentTarget.value)}
          />
          <TextInput
            label="即将维护的提示颜色"
            placeholder="gray"
            value={value.maintenances?.upcomingColor ?? ''}
            onChange={(event) =>
              onChange({
                ...value,
                maintenances: event.currentTarget.value
                  ? { upcomingColor: event.currentTarget.value }
                  : undefined,
              })
            }
          />
          <Textarea
            label="页脚 HTML"
            placeholder="留空使用默认页脚"
            value={value.customFooter ?? ''}
            autosize
            minRows={3}
            maxRows={10}
            onChange={(event) => stringField('customFooter', event.currentTarget.value)}
          />
        </Stack>
      </Paper>
      <Group justify="space-between">
        <Text fw={600}>导航链接</Text>
        <Button
          variant="light"
          onClick={() =>
            onChange({ ...value, links: [...(value.links ?? []), { label: '新链接', link: '/' }] })
          }
        >
          添加链接
        </Button>
      </Group>
      {(value.links ?? []).map((link, index) => (
        <Paper key={index} withBorder p="md">
          <Stack gap="sm">
            <Group justify="space-between">
              <Text fw={500}>{link.label || '未命名链接'}</Text>
              <Group gap={4}>
                <Button
                  size="xs"
                  variant="subtle"
                  disabled={index === 0}
                  aria-label="上移链接"
                  onClick={() => moveLink(index, -1)}
                >
                  ↑
                </Button>
                <Button
                  size="xs"
                  variant="subtle"
                  disabled={index === (value.links?.length ?? 0) - 1}
                  aria-label="下移链接"
                  onClick={() => moveLink(index, 1)}
                >
                  ↓
                </Button>
                <Button
                  size="xs"
                  variant="subtle"
                  color="red"
                  onClick={() =>
                    onChange({ ...value, links: value.links?.filter((_, item) => item !== index) })
                  }
                >
                  删除
                </Button>
              </Group>
            </Group>
            <Group grow>
              <TextInput
                label="名称"
                value={link.label}
                onChange={(event) => updateLink(index, { label: event.currentTarget.value })}
              />
              <TextInput
                label="地址"
                value={link.link}
                placeholder="https:// 或 /路径"
                onChange={(event) => updateLink(index, { link: event.currentTarget.value })}
              />
            </Group>
            <Checkbox
              label="突出显示"
              checked={link.highlight ?? false}
              onChange={(event) => updateLink(index, { highlight: event.currentTarget.checked })}
            />
          </Stack>
        </Paper>
      ))}
    </Stack>
  )
}
