import {
  Button,
  Group,
  MultiSelect,
  Paper,
  Select,
  Stack,
  Text,
  TextInput,
  Textarea,
} from '@mantine/core'
import type { MaintenanceConfig } from '@/types/config'
import type { NamedOption } from './MonitorGroupsEditor'
import { createInternalId } from '@/util/internal-id'
import {
  formatMaintenanceDateTime,
  parseMaintenanceDateTime,
  validMaintenanceTimeZone,
} from '@/util/maintenance-form'

type MaintenancePlan = MaintenanceConfig
const browserTimeZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

export default function MaintenancePlansEditor({
  value,
  monitorOptions,
  onChange,
}: {
  value: MaintenancePlan[]
  monitorOptions: NamedOption[]
  onChange: (value: MaintenancePlan[]) => void
}) {
  const update = (index: number, patch: Partial<MaintenancePlan>) =>
    onChange(value.map((plan, item) => (item === index ? { ...plan, ...patch } : plan)))
  return (
    <Stack>
      <Group justify="space-between">
        <Text fw={600}>维护计划</Text>
        <Button
          variant="light"
          onClick={() =>
            onChange([
              ...value,
              {
                id: createInternalId(
                  'maintenance',
                  new Set(value.flatMap((plan) => (plan.id ? [plan.id] : [])))
                ),
                title: '维护计划',
                body: '',
                start: new Date().toISOString(),
              },
            ])
          }
        >
          添加计划
        </Button>
      </Group>
      {value.length === 0 && (
        <Text size="sm" c="dimmed">
          暂无维护计划。
        </Text>
      )}
      {value.map((plan, index) => {
        const zone = plan.repeat?.timeZone ?? browserTimeZone()
        const validZone = validMaintenanceTimeZone(zone)
        const displayZone = validZone ? zone : browserTimeZone()
        const invalidTime = (time: number | string | undefined) =>
          typeof time === 'string' && time !== '' && !/Z$|[+-]\d{2}:\d{2}$/.test(time)
        return (
          <Paper key={plan.id ?? index} withBorder p="md">
            <Stack gap="sm">
              <Group justify="space-between">
                <Text fw={500}>{plan.title || '维护计划'}</Text>
                <Button
                  size="xs"
                  variant="subtle"
                  color="red"
                  onClick={() => onChange(value.filter((_, item) => item !== index))}
                >
                  删除
                </Button>
              </Group>
              <TextInput
                label="标题"
                value={plan.title ?? ''}
                onChange={(event) => update(index, { title: event.currentTarget.value })}
              />
              <Textarea
                label="说明"
                value={plan.body}
                autosize
                minRows={2}
                onChange={(event) => update(index, { body: event.currentTarget.value })}
              />
              <Group grow>
                <TextInput
                  type="datetime-local"
                  label="开始时间"
                  required
                  disabled={!validZone}
                  description={displayZone}
                  value={formatMaintenanceDateTime(plan.start, displayZone)}
                  error={invalidTime(plan.start) ? '请选择该时区有效的时间' : undefined}
                  onChange={(event) =>
                    update(index, {
                      start:
                        parseMaintenanceDateTime(event.currentTarget.value, displayZone) ??
                        event.currentTarget.value,
                    })
                  }
                />
                <TextInput
                  type="datetime-local"
                  label="结束时间"
                  description={plan.repeat ? '重复计划需填写结束时间' : '留空表示持续维护'}
                  value={formatMaintenanceDateTime(plan.end, displayZone)}
                  error={invalidTime(plan.end) ? '请选择该时区有效的时间' : undefined}
                  required={!!plan.repeat}
                  disabled={!validZone}
                  onChange={(event) =>
                    update(index, {
                      end: event.currentTarget.value
                        ? parseMaintenanceDateTime(event.currentTarget.value, displayZone) ??
                          event.currentTarget.value
                        : undefined,
                    })
                  }
                />
              </Group>
              <MultiSelect
                label="影响目标"
                placeholder="留空表示所有目标"
                data={monitorOptions}
                value={plan.monitors ?? []}
                searchable
                onChange={(monitors) =>
                  update(index, { monitors: monitors.length ? monitors : undefined })
                }
              />
              <Group grow>
                <Select
                  label="重复"
                  value={plan.repeat?.frequency ?? null}
                  clearable
                  placeholder="不重复"
                  data={[
                    { value: 'daily', label: '每天' },
                    { value: 'weekly', label: '每周' },
                    { value: 'monthly', label: '每月' },
                  ]}
                  onChange={(frequency) =>
                    update(index, {
                      repeat: frequency
                        ? {
                            frequency: frequency as NonNullable<
                              MaintenancePlan['repeat']
                            >['frequency'],
                            timeZone: plan.repeat?.timeZone ?? browserTimeZone(),
                          }
                        : undefined,
                    })
                  }
                />
                {plan.repeat && (
                  <TextInput
                    label="重复时区"
                    placeholder="Asia/Singapore"
                    value={plan.repeat.timeZone}
                    error={!validZone ? '请输入有效的 IANA 时区' : undefined}
                    onChange={(event) =>
                      update(index, {
                        repeat: { ...plan.repeat!, timeZone: event.currentTarget.value },
                      })
                    }
                  />
                )}
              </Group>
              <TextInput
                label="提示颜色"
                placeholder="yellow"
                value={plan.color ?? ''}
                onChange={(event) =>
                  update(index, { color: event.currentTarget.value || undefined })
                }
              />
            </Stack>
          </Paper>
        )
      })}
    </Stack>
  )
}
