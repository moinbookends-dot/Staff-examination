import { getTranslations } from 'next-intl/server'
import { AuthCard } from '@/components/auth/auth-card'
import { listOutletsForRegistration, listDepartmentsForRegistration } from '@/server/actions/org'
import { RegisterForm } from './register-form'

export default async function RegisterPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  const t = await getTranslations('auth.register')

  const [outlets, departments] = await Promise.all([
    listOutletsForRegistration(),
    listDepartmentsForRegistration(),
  ])

  return (
    <AuthCard title={t('title')} description={t('subtitle')}>
      <RegisterForm locale={locale} outlets={outlets} departments={departments} />
    </AuthCard>
  )
}
