import { getTranslations } from 'next-intl/server'

/**
 * Shell for unauthenticated screens. No navigation — there is nowhere to go
 * until you are signed in, and nav on a login page is just a way to get lost.
 */
export default async function AuthLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations('app')

  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 bg-muted/40 p-6">
      <div className="flex flex-col items-center gap-1 text-center">
        <h1 className="text-xl font-semibold tracking-tight">{t('name')}</h1>
        <p className="text-sm text-muted-foreground">{t('tagline')}</p>
      </div>

      <div className="w-full max-w-sm">{children}</div>
    </div>
  )
}
