import {
  Checkbox,
  Group,
  MultiSelect,
  NumberInput,
  Paper,
  Stack,
  Text,
  TextInput,
} from '@mantine/core'
import type { Notification } from '@/types/config'
import type { NamedOption } from './MonitorGroupsEditor'

export type NotificationDefaults = Pick<
  Notification,
  'timeZone' | 'gracePeriod' | 'skipNotificationIds' | 'skipErrorChangeNotification'
>
export default function NotificationDefaultsEditor({
  value,
  monitorOptions,
  onChange,
}: {
  value: NotificationDefaults
  monitorOptions: NamedOption[]
  onChange: (value: NotificationDefaults) => void
}) {
  return (
    <Paper withBorder p="md">
      <Stack gap="sm">
        <Text fw={600}>通知默认设置</Text>
        <Group grow>
          <NumberInput
            label="宽限时间（分钟，可选）"
            min={0}
            max={1440}
            allowDecimal={false}
            allowNegative={false}
            placeholder="0"
            value={value.gracePeriod ?? ''}
            onChange={(next) =>
              onChange({ ...value, gracePeriod: next === '' ? undefined : Number(next) })
            }
          />
          <TextInput
            label="通知时区"
            placeholder="UTC"
            value={value.timeZone ?? ''}
            onChange={(event) =>
              onChange({ ...value, timeZone: event.currentTarget.value || undefined })
            }
          />
        </Group>
        <MultiSelect
          label="关闭通知的目标"
          data={monitorOptions}
          searchable
          value={value.skipNotificationIds ?? []}
          onChange={(skipNotificationIds) => onChange({ ...value, skipNotificationIds })}
        />
        <Checkbox
          label="故障原因变化时不重复通知"
          checked={value.skipErrorChangeNotification ?? false}
          onChange={(event) =>
            onChange({ ...value, skipErrorChangeNotification: event.currentTarget.checked })
          }
        />
      </Stack>
    </Paper>
  )
}
