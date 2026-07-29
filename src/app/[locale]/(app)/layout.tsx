import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getAppClaims } from '@/lib/auth/claims'
import { visibleNavItems } from '@/lib/auth/nav'
import { logoutAction } from '@/server/actions/auth'
import { AppNav } from '@/components/shell/app-nav'
import { LocaleSwitcher } from '@/components/shell/locale-switcher'
import { ThemeToggle } from '@/components/shell/theme-toggle'
import { Button } from '@/components/ui/button'

/**
 * Authenticated shell.
 *
 * Re-checks approval here rather than trusting middleware. Middleware is a
 * routing convenience that can be bypassed by hitting routes directly; this
 * runs server-side on every render, and RLS backs it at the database. Three
 * layers, innermost authoritative.
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
  const tc = await getTranslations('common')
  const items = visibleNavItems(claims)

  const signOut = async () => {
    'use server'
    await logoutAction(locale)
  }

  return (
    <div className="flex min-h-svh flex-col">
      <header className="glass sticky top-0 z-30 flex h-14 items-center gap-4 border-b px-4 lg:px-6">
        <span className="flex items-center gap-2 font-semibold tracking-tight">
          <span
            aria-hidden
            className="grid size-7 place-items-center rounded-lg bg-primary text-[0.7rem] font-bold text-primary-foreground"
          >
            B
          </span>
          {t('name')}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <ThemeToggle />
          <LocaleSwitcher />
          <form action={signOut}>
            <Button type="submit" variant="ghost" size="sm">
              {tc('signOut')}
            </Button>
          </form>
        </div>
      </header>

      <div className="flex flex-1">
        <aside className="sticky top-14 hidden h-[calc(100svh-3.5rem)] w-60 shrink-0 border-r bg-sidebar/60 p-3 md:block">
          <AppNav items={items} />
        </aside>

        {/* pb-24 below md leaves room for the fixed bottom nav, which would
            otherwise sit on top of the last row of every list. */}
        <main className="min-w-0 flex-1 p-4 pb-24 md:pb-6 lg:p-6 lg:pb-6">{children}</main>
      </div>

      {/* Mobile navigation. Restaurant staff are overwhelmingly on phones, so
          this is the primary path, not a fallback. Fixed rather than in flow:
          on a long list the nav used to be reachable only by scrolling to the
          bottom of the page. */}
      <div className="glass fixed inset-x-0 bottom-0 z-30 border-t px-2 py-1.5 md:hidden">
        <div className="flex gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
          <AppNav items={items} orientation="horizontal" />
        </div>
      </div>
    </div>
  )
}
