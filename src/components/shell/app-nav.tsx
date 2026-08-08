'use client'

import { useTranslations } from 'next-intl'
import {
  Database,
  FilePlus2,
  History,
  LayoutDashboard,
  Settings,
  ShieldCheck,
  TagsIcon,
  UploadIcon,
  Sparkles,
  UserRound,
  UserRoundCheck,
  type LucideIcon,
} from 'lucide-react'
import { Link, usePathname } from '@/lib/i18n/navigation'
import type { NavIcon, NavItem } from '@/lib/auth/nav'
import { cn } from '@/lib/utils'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Primary navigation, per the Stitch design.
 *
 * Items are computed server-side from the user's claims and passed in — the
 * client never receives links it is not entitled to, and the permission logic
 * stays in one place (src/lib/auth/nav.ts).
 *
 * Rendered in two places by two components:
 *   SidebarNav  — the desktop rail, with an active pill and a right-edge tab
 *   MobileTabBar — the fixed bottom bar below `md`
 *
 * They are separate components rather than one with an `orientation` prop.
 * The previous single component took that prop and the horizontal instance
 * inherited `flex-col`, so eleven links stacked into a column inside a
 * container that only scrolled sideways. The two layouts share nothing but an
 * icon map, and pretending otherwise produced a nav several screens tall.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * The string → component map nav.ts deliberately does not hold: NAV_ITEMS
 * crosses the server/client boundary and a component reference would not
 * survive serialisation.
 */
const ICONS: Record<NavIcon, LucideIcon> = {
  dashboard: LayoutDashboard,
  bank: Database,
  generate: FilePlus2,
  history: History,
  editors: ShieldCheck,
  settings: Settings,
  guide: Sparkles,
  approvals: UserRoundCheck,
  topics: TagsIcon,
  import: UploadIcon,
  profile: UserRound,
}

/** Exact match for /dashboard, prefix elsewhere so /questions/123 stays lit. */
function useIsActive() {
  const pathname = usePathname()
  return (href: string) =>
    href === '/dashboard'
      ? pathname === href
      : pathname === href || pathname.startsWith(`${href}/`)
}

export function SidebarNav({ items }: { items: NavItem[] }) {
  const t = useTranslations('nav')
  const isActive = useIsActive()

  return (
    <nav className="flex flex-col gap-1" aria-label="Main">
      {items.map((item) => {
        const active = isActive(item.href)
        const Icon = ICONS[item.icon]

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'group relative flex items-center gap-3 rounded-md px-3 py-2.5 text-body-sm transition-colors',
              active
                ? 'bg-accent font-medium text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )}
          >
            <Icon
              aria-hidden
              className={cn(
                'size-5 shrink-0 transition-colors',
                active ? 'text-primary' : 'text-muted-foreground/80 group-hover:text-foreground',
              )}
            />
            {t(item.labelKey)}

            {/* The tab on the right edge of the active item, which the Stitch
                sidebar uses instead of a left rail. Decorative — `aria-current`
                above is what a screen reader announces. */}
            {active && (
              <span
                aria-hidden
                className="absolute -right-3 top-1/2 h-8 w-1.5 -translate-y-1/2 rounded-l-full bg-primary"
              />
            )}
          </Link>
        )
      })}
    </nav>
  )
}

/**
 * The fixed bottom bar below `md`.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE TAB COUNT VARIES, AND THE LAYOUT MUST NOT ASSUME FIVE.                │
 * │                                                                           │
 * │ A Chef holds no bank.* permission, so the Questions tab is absent for     │
 * │ them — four tabs, not five. `flex-1` on each item distributes whatever    │
 * │ arrives, so neither case reads as though something failed to load.        │
 * │                                                                           │
 * │ A grid with five fixed columns would leave a Chef staring at an empty     │
 * │ slot.                                                                     │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export function MobileTabBar({ items }: { items: NavItem[] }) {
  const t = useTranslations('nav')
  const isActive = useIsActive()

  return (
    <nav className="flex items-stretch" aria-label="Main">
      {items.map((item) => {
        const active = isActive(item.href)
        const Icon = ICONS[item.icon]

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className="flex flex-1 flex-col items-center justify-center gap-1 px-1 py-2"
          >
            {/*
              The active tab is a filled pill around the ICON only, with the
              label beneath it — the Stitch mobile bar's treatment. Applying the
              fill to the whole cell instead makes the bar look like a segmented
              control and the labels become hard to read at this size.
            */}
            <span
              className={cn(
                'flex h-8 w-12 items-center justify-center rounded-full transition-colors',
                active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground',
              )}
            >
              <Icon aria-hidden className="size-5" />
            </span>
            <span
              className={cn(
                'text-[0.6875rem] leading-none',
                active ? 'font-medium text-foreground' : 'text-muted-foreground',
              )}
            >
              {t(item.labelKey)}
            </span>
          </Link>
        )
      })}
    </nav>
  )
}
