import { Suspense } from 'react'
import { getTranslations } from 'next-intl/server'
import { AuthCard } from '@/components/auth/auth-card'
import { LoginForm } from './login-form'

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
    </AuthCard>
  )
}
