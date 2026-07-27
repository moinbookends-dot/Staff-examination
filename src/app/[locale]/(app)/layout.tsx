import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getAppClaims } from '@/lib/auth/claims'
import { visibleNavItems } from '@/lib/auth/nav'
import { logoutAction } from '@/server/actions/auth'
import { AppNav } from '@/components/shell/app-nav'
import { LocaleSwitcher } from '@/components/shell/locale-switcher'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'

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
      <header className="flex h-14 items-center gap-4 border-b px-4 lg:px-6">
        <span className="font-semibold tracking-tight">{t('name')}</span>
        <div className="ml-auto flex items-center gap-2">
          <LocaleSwitcher />
          <form action={signOut}>
            <Button type="submit" variant="ghost" size="sm">
              {tc('signOut')}
            </Button>
          </form>
        </div>
      </header>

      <div className="flex flex-1">
        <aside className="hidden w-56 shrink-0 border-r p-3 md:block">
          <AppNav items={items} />
        </aside>

        <main className="flex-1 p-4 lg:p-6">{children}</main>
      </div>

      {/* Mobile navigation. Restaurant staff are overwhelmingly on phones, so
          this is the primary path, not a fallback. */}
      <div className="border-t p-2 md:hidden">
        <Separator className="mb-2" />
        <div className="flex gap-1 overflow-x-auto">
          <AppNav items={items} />
        </div>
      </div>
    </div>
  )
}
