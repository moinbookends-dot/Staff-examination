'use client'

import { useTranslations } from 'next-intl'
import { Link, usePathname } from '@/lib/i18n/navigation'
import type { NavItem } from '@/lib/auth/nav'
import { cn } from '@/lib/utils'

/**
 * Primary navigation. Items are computed server-side from the user's claims
 * and passed in — the client never sees links it isn't entitled to, and the
 * permission logic stays in one place.
 */
export function AppNav({ items }: { items: NavItem[] }) {
  const t = useTranslations('nav')
  const pathname = usePathname()

  return (
    <nav className="flex flex-col gap-1" aria-label="Main">
      {items.map((item) => {
        // Exact match for /dashboard, prefix match elsewhere so
        // /exams/123/builder still highlights "Exams".
        const active =
          item.href === '/dashboard'
            ? pathname === item.href
            : pathname === item.href || pathname.startsWith(`${item.href}/`)

        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'rounded-md px-3 py-2 text-sm transition-colors',
              active
                ? 'bg-accent font-medium text-accent-foreground'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )}
          >
            {t(item.labelKey)}
          </Link>
        )
      })}
    </nav>
  )
}
