import { getTranslations } from 'next-intl/server'
import { getAppClaims, can } from '@/lib/auth/claims'
import { SectionTabs } from '@/components/shell/section-tabs'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The Papers section header — Generate and Exam History, under one nav item.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ A COMPONENT, NOT A LAYOUT, BECAUSE THE TWO ROUTES ARE NOT SIBLINGS.      │
 * │                                                                           │
 * │ /papers/generate and /history live in different segments — /history was   │
 * │ named before the section existed and keeps its URL because paper links    │
 * │ are handed around. A Next layout can only wrap one subtree, so a shared   │
 * │ component is what covers both without moving a route somebody has         │
 * │ bookmarked.                                                              │
 * │                                                                           │
 * │ It also means /history/[id] can leave the tabs off: a single paper is a   │
 * │ destination, not one of two lists, and the back link it already carries   │
 * │ says so more clearly than a tab bar would.                                │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Each tab is gated on the permission its page requires, so a reader who holds
 * only one of them sees no tab bar at all — SectionTabs declines to render a
 * single choice.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export async function PapersTabs() {
  const claims = await getAppClaims()
  const t = await getTranslations('nav')

  const tabs = [
    ...(can(claims, 'papers.generate') ? [{ href: '/papers/generate', label: t('generate') }] : []),
    ...(can(claims, 'papers.read_history') ? [{ href: '/history', label: t('history'), exact: true }] : []),
  ]

  return <SectionTabs tabs={tabs} label={t('papers')} />
}
