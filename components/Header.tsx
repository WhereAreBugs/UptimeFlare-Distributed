import { Container, Group, Image } from '@mantine/core'
import classes from '@/styles/Header.module.css'
import { pageConfig as fallbackPageConfig } from '@/util/public-defaults'
import type { PageConfig, PageConfigLink } from '@/types/config'
import { useTranslation } from 'react-i18next'
import { useRouter } from 'next/router'

export default function Header({
  style,
  page = fallbackPageConfig,
}: {
  style?: React.CSSProperties
  page?: PageConfig
}) {
  const { t } = useTranslation('common')
  const { pathname } = useRouter()
  const linkToElement = (link: PageConfigLink, i: number) => {
    return (
      <a
        key={i}
        href={link.link}
        target={link.link.startsWith('/') ? undefined : '_blank'}
        rel={link.link.startsWith('/') ? undefined : 'noreferrer'}
        className={classes.link}
        data-active={link.highlight}
      >
        {link.label}
      </a>
    )
  }

  const links = [{ label: t('Incidents'), link: '/incidents' }, ...(page.links || [])]

  return (
    <header className={classes.header} style={style}>
      <Container size="md" className={classes.inner}>
        <div>
          <a
            href={
              pathname === '/' ? 'https://github.com/WhereAreBugs/UptimeFlare-Distributed' : '/'
            }
            target={pathname === '/' ? '_blank' : undefined}
            rel={pathname === '/' ? 'noreferrer' : undefined}
          >
            <Image
              src={page.logo ?? '/brand/status-suzume.webp'}
              h={48}
              w={{ base: 128, sm: 176 }}
              fit="contain"
              alt="Status"
            />
          </a>
        </div>

        <Group gap={5} visibleFrom="sm">
          {links?.map(linkToElement)}
        </Group>

        <Group gap={5} hiddenFrom="sm">
          {links?.filter((link) => link.highlight || link.link.startsWith('/')).map(linkToElement)}
        </Group>
      </Container>
    </header>
  )
}
