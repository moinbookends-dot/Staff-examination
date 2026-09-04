import { getTranslations } from 'next-intl/server'
import { getAppClaims, can } from '@/lib/auth/claims'
import { SectionTabs } from '@/components/shell/section-tabs'

/**
 * The Users section header — the directory and registration approvals, under
 * one nav item, exactly the way Papers holds Generate and Exam History.
 *
 * Each tab is gated on the permission its page requires, so somebody holding
 * only one of them sees no tab bar at all — SectionTabs declines to render a
 * single choice. /users/[id] deliberately renders no tabs: a person is a
 * destination, not one of two lists, and the back link already on that page
 * says so more clearly than a tab bar would.
 */
export async function UsersTabs() {
  const claims = await getAppClaims()
  const t = await getTranslations('nav')

  const tabs = [
    ...(can(claims, 'users.read_team') || can(claims, 'users.read_all')
      ? // exact: '/users' is a prefix of its sibling, and of /users/[id].
        [{ href: '/users', label: t('users'), exact: true }]
      : []),
    ...(can(claims, 'users.approve')
      ? [{ href: '/users/approvals', label: t('approvals') }]
      : []),
  ]

  return <SectionTabs tabs={tabs} label={t('users')} />
}
