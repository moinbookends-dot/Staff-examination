'use client'

import { useTranslations } from 'next-intl'
import {
  ChartNoAxesColumn,
  ClipboardCheck,
  FileCheck2,
  FileText,
  GraduationCap,
  LayoutDashboard,
  Library,
  ShieldCheck,
  UserRoundCheck,
  type LucideIcon,
} from 'lucide-react'
import { Link, usePathname } from '@/lib/i18n/navigation'
import type { NavIcon, NavItem } from '@/lib/auth/nav'
import { cn } from '@/lib/utils'

/**
 * The string → component map nav.ts deliberately does not hold: NAV_ITEMS
 * crosses the server/client boundary and a component reference would not
 * survive it.
 */
const ICONS: Record<NavIcon, LucideIcon> = {
  dashboard: LayoutDashboard,
  myExams: GraduationCap,
  questions: Library,
  exams: FileText,
  evaluate: ClipboardCheck,
  verify: FileCheck2,
  results: ShieldCheck,
  reports: ChartNoAxesColumn,
  approvals: UserRoundCheck,
}

/**
 * Primary navigation. Items are computed server-side from the user's claims
 * and passed in — the client never sees links it isn't entitled to, and the
 * permission logic stays in one place.
 *
 * Rendered twice per page: as a sidebar rail above `md`, and as a scrolling
 * strip along the bottom below it. The horizontal instance used to inherit
 * `flex-col`, so eleven links stacked into a column inside a container that
 * only scrolls sideways — the mobile nav was several screens tall and the
 * overflow went the wrong way.
 */
export function AppNav({
  items,
  orientation = 'vertical',
}: {
  items: NavItem[]
  orientation?: 'vertical' | 'horizontal'
}) {
  const t = useTranslations('nav')
  const pathname = usePathname()
  const horizontal = orientation === 'horizontal'

  return (
    <nav
      className={cn('flex gap-1', horizontal ? 'flex-row' : 'flex-col')}
      aria-label="Main"
    >
      {items.map((item) => {
        // Exact match for /dashboard, prefix match elsewhere so
        // /exams/123/builder still highlights "Exams".
        const active =
          item.href === '/dashboard'
            ? pathname === item.href
            : pathname === item.href || pathname.startsWith(`${item.href}/`)

        const Icon = ICONS[item.icon]

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'group relative flex items-center rounded-lg text-sm transition-colors',
              horizontal
                ? 'shrink-0 flex-col gap-1 px-3 py-1.5 text-xs'
                : 'gap-2.5 px-3 py-2',
              active
                ? 'bg-sidebar-accent font-medium text-sidebar-accent-foreground'
                : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground',
            )}
          >
            {/* A rail on the active item, so the current section is legible at
                a glance rather than only by a slight change in background. */}
            {active && !horizontal && (
              <span
                aria-hidden
                className="absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-primary"
              />
            )}
            <Icon
              aria-hidden
              className={cn(
                'size-4 shrink-0 transition-colors',
                active ? 'text-primary' : 'text-muted-foreground/70 group-hover:text-foreground',
              )}
            />
            {t(item.labelKey)}
          </Link>
        )
      })}
    </nav>
  )
}
