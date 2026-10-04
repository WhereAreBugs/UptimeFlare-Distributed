import { Button, Group, MultiSelect, Paper, Stack, Text, TextInput } from '@mantine/core'
import type { PageConfigGroup } from '@/types/config'

export type NamedOption = { value: string; label: string }

export function applyGroupDraftNames(
  groups: PageConfigGroup,
  drafts: Record<string, string>
): PageConfigGroup {
  const names = new Set<string>()
  return Object.fromEntries(
    Object.entries(groups).map(([name, monitors]) => {
      const next = (drafts[name] ?? name).trim()
      if (!next) throw new Error('分组名称不能为空')
      if (names.has(next)) throw new Error('分组名称不能重复')
      names.add(next)
      return [next, monitors]
    })
  )
}

export default function MonitorGroupsEditor({
  value,
  monitorOptions,
  draftNames,
  onChange,
  onDraftChange,
}: {
  value: PageConfigGroup
  monitorOptions: NamedOption[]
  draftNames: Record<string, string>
  onChange: (value: PageConfigGroup) => void
  onDraftChange: (key: string, name: string) => void
}) {
  const groups = Object.entries(value)
  const move = (index: number, direction: number) => {
    const changed = [...groups]
    ;[changed[index], changed[index + direction]] = [changed[index + direction], changed[index]]
    onChange(Object.fromEntries(changed))
  }
  return (
    <Stack>
      <Group justify="space-between">
        <Text fw={600}>分组</Text>
        <Button
          variant="light"
          onClick={() => {
            let name = '新分组',
              suffix = 2
            const used = new Set(groups.map(([key]) => draftNames[key] ?? key))
            while (name in value || used.has(name)) name = `新分组 ${suffix++}`
            onChange({ ...value, [name]: [] })
          }}
        >
          添加分组
        </Button>
      </Group>
      {groups.length === 0 && (
        <Text size="sm" c="dimmed">
          未分组的目标会直接显示。
        </Text>
      )}
      {groups.map(([key, monitors], index) => {
        const name = draftNames[key] ?? key
        const duplicate = groups.some(
          ([other]) => other !== key && (draftNames[other] ?? other).trim() === name.trim()
        )
        return (
          <Paper key={key} withBorder p="md">
            <Stack gap="sm">
              <Group justify="space-between">
                <Text fw={500}>{name || '未命名分组'}</Text>
                <Group gap={4}>
                  <Button
                    size="xs"
                    variant="subtle"
                    disabled={index === 0}
                    aria-label="上移分组"
                    onClick={() => move(index, -1)}
                  >
                    ↑
                  </Button>
                  <Button
                    size="xs"
                    variant="subtle"
                    disabled={index === groups.length - 1}
                    aria-label="下移分组"
                    onClick={() => move(index, 1)}
                  >
                    ↓
                  </Button>
                  <Button
                    size="xs"
                    variant="subtle"
                    color="red"
                    onClick={() =>
                      onChange(Object.fromEntries(groups.filter(([name]) => name !== key)))
                    }
                  >
                    删除
                  </Button>
                </Group>
              </Group>
              <TextInput
                label="名称"
                value={name}
                error={!name.trim() ? '名称不能为空' : duplicate ? '名称不能重复' : undefined}
                onChange={(event) => onDraftChange(key, event.currentTarget.value)}
              />
              <MultiSelect
                label="监控目标"
                data={monitorOptions}
                value={monitors.filter((id) =>
                  monitorOptions.some((option) => option.value === id)
                )}
                onChange={(selected) => onChange({ ...value, [key]: selected })}
                searchable
              />
            </Stack>
          </Paper>
        )
      })}
    </Stack>
  )
}
