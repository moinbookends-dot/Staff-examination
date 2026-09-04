'use client'

import { useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslations } from 'next-intl'
import {
  Award,
  MenuIcon,
  UsersRound,
  ClipboardList,
  Database,
  FilePlus2,
  LayoutDashboard,
  PenLine,
  RadioIcon,
  Settings,
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
  users: UsersRound,
  dashboard: LayoutDashboard,
  bank: Database,
  generate: FilePlus2,
  liveExams: RadioIcon,
  evaluate: PenLine,
  myExams: ClipboardList,
  results: Award,
  approvals: UserRoundCheck,
  settings: Settings,
}

/**
 * Exact match for /dashboard, prefix elsewhere so /questions/123 stays lit.
 *
 * `activeFor` adds prefixes a section owns but does not share a path with —
 * Papers is one item covering /papers/generate and /history, and without it the
 * sidebar would go dark on the paper page.
 *
 * IT ALSO ABSORBS A PER-VIEWER HREF. The Papers item resolves its href from the
 * reader's permissions (nav.ts, `hrefFor`): a generate-holder lands on
 * /papers/generate, somebody with history access alone lands on /history. Both
 * prefixes stay in `activeFor` for both of them, so the rule below —
 * `matches(href) || any(matches(activeFor))` — lights the item on either route
 * regardless of which one it points at.
 */
function useIsActive() {
  const pathname = usePathname()

  return (item: NavItem) => {
    if (item.href === '/dashboard') return pathname === item.href

    const matches = (prefix: string) =>
      pathname === prefix || pathname.startsWith(`${prefix}/`)

    return matches(item.href) || (item.activeFor?.some(matches) ?? false)
  }
}

export function SidebarNav({ items }: { items: NavItem[] }) {
  const t = useTranslations('nav')
  const isActive = useIsActive()

  return (
    <nav className="flex flex-col gap-1" aria-label="Main">
      {items.map((item) => {
        const active = isActive(item)
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
        const active = isActive(item)
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
              {/* The short label where there is one: five tabs across a phone
                  give each about 78px, and a label that wraps sits lower than
                  its neighbours and makes the whole bar look misaligned. */}
              {t(item.shortLabelKey ?? item.labelKey)}
            </span>
          </Link>
        )
      })}
    </nav>
  )
}

/**
 * The rest of the app, on a phone.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE TAB BAR CAPS AT FIVE, AND BELOW `md` THE SIDEBAR DOES NOT EXIST — so  ║
 * ║ until this component, Approvals, Evaluate, Reports, History and Settings  ║
 * ║ were REACHABLE ON A PHONE ONLY BY TYPING THE URL. nav.ts's comment        ║
 * ║ ("the sidebar always carries the complete list — nothing is unreachable") ║
 * ║ was true only at desktop widths, and the shell.openMenu / closeMenu       ║
 * ║ message keys had been sitting in all three bundles, wired to nothing.     ║
 * ║                                                                           ║
 * ║ A bottom sheet, not a hamburger drawer: it matches the notification       ║
 * ║ panel's established pattern and sits where the thumb already is.          ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Portaled to <body> for the same measured reason as the notification bell:
 * the header's `glass` backdrop-filter makes it a containing block, so a
 * fixed-position sheet would pin to the header instead of the viewport.
 */
export function MobileMenu({ items }: { items: NavItem[] }) {
  const t = useTranslations('nav')
  const ts = useTranslations('shell')
  const isActive = useIsActive()
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        aria-label={open ? ts('closeMenu') : ts('openMenu')}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="grid min-h-11 min-w-11 place-items-center rounded-md text-foreground md:hidden"
      >
        <MenuIcon aria-hidden className="size-5" />
      </button>

      {open &&
        createPortal(
          <>
            <button
              type="button"
              aria-label={ts('closeMenu')}
              className="fixed inset-0 z-40 cursor-default bg-black/40 md:hidden"
              onClick={() => setOpen(false)}
            />
            <nav
              aria-label={ts('openMenu')}
              className="pb-safe fixed inset-x-0 bottom-0 z-50 max-h-[75dvh] overflow-y-auto rounded-t-xl border bg-card shadow-lg md:hidden"
            >
              <ul className="grid grid-cols-2 gap-1 p-3">
                {items.map((item) => {
                  const active = isActive(item)
                  const Icon = ICONS[item.icon]
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        aria-current={active ? 'page' : undefined}
                        onClick={() => setOpen(false)}
                        className={cn(
                          'flex min-h-12 items-center gap-3 rounded-md px-3 text-sm font-medium',
                          active
                            ? 'bg-primary text-primary-foreground'
                            : 'text-foreground hover:bg-accent',
                        )}
                      >
                        <Icon aria-hidden className="size-4 shrink-0" />
                        <span className="truncate">{t(item.labelKey)}</span>
                      </Link>
                    </li>
                  )
                })}
              </ul>
            </nav>
          </>,
          document.body,
        )}
    </>
  )
}
