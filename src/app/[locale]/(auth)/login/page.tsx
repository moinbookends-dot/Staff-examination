import { Suspense } from 'react'
import { getTranslations } from 'next-intl/server'
import { AuthCard } from '@/components/auth/auth-card'
import { LoginForm } from './login-form'

/**
 * Reads the sample logins off disk and renders the quick-fill panel.
 *
 * A Server Component, and fs is the point: nothing imports the credentials, so
 * nothing can bundle them. Only called when NODE_ENV is not production.
 */
async function DevLoginPanel() {
  const { readFileSync } = await import('node:fs')
  const { resolve } = await import('node:path')
  const { DevQuickLogin } = await import('@/components/auth/dev-quick-login')

  // Only the READ is guarded. JSX inside a try/catch would not do what it
  // looks like it does — React renders later, so a render error escapes the
  // catch entirely and needs an error boundary instead.
  let data: { password: string; accounts: { email: string; label: string; can: string }[] }
  try {
    data = JSON.parse(readFileSync(resolve(process.cwd(), 'dev-accounts.json'), 'utf-8'))
  } catch {
    // No sample data seeded, or the file was removed. Nothing to offer.
    return null
  }

  return <DevQuickLogin password={data.password} accounts={data.accounts} />
}

export default async function LoginPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  const t = await getTranslations('auth.login')

  return (
    <AuthCard title={t('title')} description={t('subtitle')}>
      {/* useSearchParams needs a Suspense boundary, otherwise the whole route
          opts out of static rendering. */}
      <Suspense fallback={null}>
        <LoginForm locale={locale} />
      </Suspense>

      {/*
        THE PRODUCTION GUARD.

        A NODE_ENV check alone was NOT enough, and this is the second attempt.
        The first version imported dev-accounts.json as a module behind exactly
        this condition — and a production build still contained the password,
        in .next/static and .next/server both. A static import joins the module
        graph regardless of what a runtime condition later decides to render.

        So the file now lives outside src/ and is read with fs, here, only when
        the condition holds. In production the read never happens and no
        credential exists anywhere in the build to be found.
      */}
      {process.env.NODE_ENV !== 'production' && <DevLoginPanel />}
    </AuthCard>
  )
}
