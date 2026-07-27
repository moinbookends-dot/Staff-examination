import { Suspense } from 'react'
import { getTranslations } from 'next-intl/server'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { LoginForm } from './login-form'

export default async function LoginPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  const t = await getTranslations('auth.login')

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('subtitle')}</CardDescription>
      </CardHeader>
      <CardContent>
        {/* useSearchParams needs a Suspense boundary, otherwise the whole route
            opts out of static rendering. */}
        <Suspense fallback={null}>
          <LoginForm locale={locale} />
        </Suspense>
      </CardContent>
    </Card>
  )
}
