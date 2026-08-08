import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { BellIcon, CircleHelpIcon, SearchIcon, UtensilsCrossedIcon } from 'lucide-react'
import { getAppClaims } from '@/lib/auth/claims'
import { mobileNavItems, visibleFootItems, visibleNavItems } from '@/lib/auth/nav'
import { logoutAction } from '@/server/actions/auth'
import { MobileTabBar, SidebarNav } from '@/components/shell/app-nav'
import { LocaleSwitcher } from '@/components/shell/locale-switcher'
import { ThemeToggle } from '@/components/shell/theme-toggle'
import { Button } from '@/components/ui/button'
import { Link } from '@/lib/i18n/navigation'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Authenticated shell, per the Stitch design.
 *
 * Sidebar owns the brand and pins Settings to its foot; the top bar carries
 * search and account controls. Below `md` the sidebar is replaced by a fixed
 * five-slot tab bar.
 *
 * Re-checks approval here rather than trusting middleware. Middleware is a
 * routing convenience that can be bypassed by hitting routes directly; this
 * runs server-side on every render, and RLS backs it at the database. Three
 * layers, innermost authoritative.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export default async function AppLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  const claims = await getAppClaims()

  if (!claims.approved) {
    redirect(`/${locale}/pending`)
  }

  const t = await getTranslations('app')
  const ts = await getTranslations('shell')
  const tc = await getTranslations('common')

  const items = visibleNavItems(claims)
  const footItems = visibleFootItems(claims)
  const tabs = mobileNavItems(claims)

  const signOut = async () => {
    'use server'
    await logoutAction(locale)
  }

  return (
    <div className="flex min-h-svh">
      {/* ── Sidebar ──────────────────────────────────────────────────────
          320px, matching the Stitch proportion (20% of a 1600px canvas).
          `sticky` with its own height so the nav stays put while a long
          question list scrolls. */}
      <aside className="sticky top-0 hidden h-svh w-80 shrink-0 flex-col border-r bg-card md:flex">
        {/* A link, not a static block. The logo is the one element every user
            expects to return them to the start, and it costs nothing here. */}
        <Link
          href="/dashboard"
          className="flex items-center gap-3 border-b px-6 py-5 transition-colors hover:bg-accent/40"
        >
          <span
            aria-hidden
            className="grid size-10 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground"
          >
            <UtensilsCrossedIcon className="size-5" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-title-md">{t('name')}</span>
            <span className="block truncate text-label-caps text-muted-foreground">
              {t('subtitle')}
            </span>
          </span>
        </Link>

        {/* pr-3 leaves room for the active item's right-edge tab, which is
            positioned outside the link's own box. */}
        <div className="flex-1 overflow-y-auto px-3 py-4 pr-3">
          <SidebarNav items={items} />
        </div>

        {footItems.length > 0 && (
          <div className="border-t px-3 py-4 pr-3">
            <SidebarNav items={footItems} />
          </div>
        )}
      </aside>

      {/* ── Main column ──────────────────────────────────────────────── */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="glass sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b px-4 lg:px-10">
          {/* The brand repeats here below `md` only — the sidebar that
              normally carries it is not rendered at that width. */}
          <span className="flex items-center gap-2 md:hidden">
            <span
              aria-hidden
              className="grid size-8 place-items-center rounded-md bg-primary text-primary-foreground"
            >
              <UtensilsCrossedIcon className="size-4" />
            </span>
            <span className="truncate text-title-md">{t('name')}</span>
          </span>

          {/* Search is presentational until there is something to search
              across. Rendered because the Stitch header is built around it and
              the row collapses without it; disabled and labelled so it cannot
              be mistaken for a control that does nothing by accident. */}
          <div className="relative ml-auto hidden max-w-md flex-1 md:block">
            <SearchIcon
              aria-hidden
              className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="search"
              disabled
              aria-label={ts('search')}
              placeholder={ts('search')}
              className="h-10 w-full rounded-md border border-input bg-muted/40 pl-9 pr-3 text-body-sm placeholder:text-muted-foreground disabled:cursor-not-allowed"
            />
          </div>

          <div className="ml-auto flex items-center gap-1 md:ml-0">
            <Button variant="ghost" size="icon" aria-label={ts('notifications')} disabled>
              <BellIcon />
            </Button>
            <Button variant="ghost" size="icon" aria-label={ts('help')} disabled>
              <CircleHelpIcon />
            </Button>
            <ThemeToggle />
            <LocaleSwitcher />
            <form action={signOut}>
              <Button type="submit" variant="ghost" size="sm">
                {tc('signOut')}
              </Button>
            </form>
          </div>
        </header>

        {/* pb-24 below md leaves room for the fixed tab bar, which would
            otherwise sit on top of the last row of every list.
            px-4 / lg:px-10 is DESIGN.md's 16px mobile, 40px desktop margin. */}
        <main className="min-w-0 flex-1 px-4 py-6 pb-24 md:pb-6 lg:px-10">{children}</main>
      </div>

      {/* ── Mobile tab bar ───────────────────────────────────────────────
          Restaurant staff are overwhelmingly on phones, so this is the primary
          path rather than a fallback. Fixed rather than in flow: on a long list
          the nav used to be reachable only by scrolling to the bottom. */}
      <div className="glass fixed inset-x-0 bottom-0 z-30 border-t md:hidden">
        <MobileTabBar items={tabs} />
      </div>
    </div>
  )
}
