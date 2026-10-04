import { Text } from '@mantine/core'
import { useTranslation } from 'react-i18next'
import type { PublicSnapshotMetadata } from '@/util/public-snapshot'

export default function PublicSnapshotNotice({
  snapshotAt,
  stale,
  snapshotIncomplete,
}: PublicSnapshotMetadata) {
  const { t } = useTranslation('common')
  return (
    <div>
      {snapshotAt !== null && snapshotAt !== undefined && Number.isFinite(snapshotAt) && (
        <Text size="xs" c="dimmed" mt={4}>
          {t('Public snapshot generated', { date: new Date(snapshotAt * 1000).toLocaleString() })}
        </Text>
      )}
      {(stale || snapshotIncomplete) && (
        <Text size="xs" c="orange" mt={4} role="status">
          {t(snapshotIncomplete ? 'Public snapshot incomplete' : 'Public snapshot stale')}
        </Text>
      )}
    </div>
  )
}
