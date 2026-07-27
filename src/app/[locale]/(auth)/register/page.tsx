import { getTranslations } from 'next-intl/server'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
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
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('subtitle')}</CardDescription>
      </CardHeader>
      <CardContent>
        <RegisterForm locale={locale} outlets={outlets} departments={departments} />
      </CardContent>
    </Card>
  )
}
