import { Divider } from '@mantine/core'
import { pageConfig as fallbackPageConfig } from '@/util/public-defaults'
import type { PageConfig } from '@/types/config'

export default function Footer({ page = fallbackPageConfig }: { page?: PageConfig } = {}) {
  const defaultFooter =
    '<p style="text-align: center; font-size: 12px; margin-top: 10px;"> Open-source monitoring and status page powered by <a href="https://github.com/lyc8503/UptimeFlare" target="_blank">Uptimeflare</a>, made with ❤ by <a href="https://github.com/lyc8503" target="_blank">lyc8503</a>. </p>'

  return (
    <>
      <Divider mt="lg" />
      <div dangerouslySetInnerHTML={{ __html: page.customFooter ?? defaultFooter }} />
    </>
  )
}
