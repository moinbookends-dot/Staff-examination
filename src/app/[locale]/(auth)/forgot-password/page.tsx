import { getTranslations } from 'next-intl/server'
import { AuthCard } from '@/components/auth/auth-card'
import { ForgotPasswordForm } from './forgot-password-form'

export default async function ForgotPasswordPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  const t = await getTranslations('auth.forgotPassword')

  return (
    <AuthCard title={t('title')} description={t('body')}>
      <ForgotPasswordForm locale={locale} />
    </AuthCard>
  )
}
