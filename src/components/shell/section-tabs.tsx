'use client'

import { Link, usePathname } from '@/lib/i18n/navigation'
import { cn } from '@/lib/utils'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The tabs inside a sidebar section.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ LINKS, NOT A TABLIST — AND THAT IS AN ACCESSIBILITY DECISION, NOT A       ║
 * ║ SHORTCUT.                                                                 ║
 * ║                                                                           ║
 * ║ role="tablist" promises arrow-key movement between panels that are        ║
 * ║ already in the document. These are separate ROUTES: each one is its own   ║
 * ║ page, bookmarkable, openable in a new tab, and it survives a reload with  ║
 * ║ no JavaScript at all. Announcing them as tabs would describe behaviour    ║
 * ║ they do not have.                                                         ║
 * ║                                                                           ║
 * ║ The same reasoning is written out at length in the Guide's document-type  ║
 * ║ tabs and in ExamSection; this is that pattern extracted so the sidebar    ║
 * ║ consolidation did not produce a third copy of it.                        ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Active by PREFIX, so /questions/new and /questions/[id] keep the Questions
 * tab lit rather than leaving the reader on a section with nothing selected.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface SectionTab {
  href: string
  label: string
  /** Exact match only — for a tab whose href is a prefix of its siblings'. */
  exact?: boolean
}

export function SectionTabs({ tabs, label }: { tabs: SectionTab[]; label: string }) {
  const pathname = usePathname()

  // Fewer than two destinations is not a choice; rendering a single tab would
  // be decoration that costs a row of vertical space on a phone.
  if (tabs.length < 2) return null

  return (
    <nav className="flex flex-wrap gap-1 border-b" aria-label={label}>
      {tabs.map((tab) => {
        const active = tab.exact
          ? pathname === tab.href
          : pathname === tab.href || pathname.startsWith(`${tab.href}/`)

        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              // min-h-11 is 44px: these are the primary way between sections
              // on a phone and measured 42px, which is under the floor by just
              // enough to be missed by a thumb and by a reviewer.
              '-mb-px flex min-h-11 items-center border-b-2 px-3 py-2 text-body-sm transition-colors md:min-h-0',
              active
                ? 'border-primary font-medium text-foreground'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label}
          </Link>
        )
      })}
    </nav>
  )
}
