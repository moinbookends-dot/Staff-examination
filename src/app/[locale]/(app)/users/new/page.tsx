import { getTranslations } from 'next-intl/server'
import { ArrowLeftIcon } from 'lucide-react'
import { requirePermission } from '@/lib/auth/guards'
import { Link } from '@/lib/i18n/navigation'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { PageHeader } from '@/components/ui/page-header'
import { listOutletsForRegistration, listDepartmentsForRegistration } from '@/server/actions/org'
import { CreateUserForm } from './create-user-form'
import { cn } from '@/lib/utils'

/**
 * /users/new — an admin creates a staff account directly.
 *
 * Self-registration still exists and still lands in the approvals queue; this
 * is the counter-side for the person standing next to you on their first
 * shift, who needs an account NOW and has no working inbox yet. Same
 * authority as approving (users.approve), because it IS approving — the
 * action runs the same approve_registration() spine after minting the
 * account. Like /users/[id], a destination: no section tabs.
 */
export default async function CreateUserPage() {
  await requirePermission('users.approve')
  const t = await getTranslations('users')

  const [outlets, departments] = await Promise.all([
    listOutletsForRegistration(),
    listDepartmentsForRegistration(),
  ])

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <div>
        <Link
          href="/users"
          className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), '-ml-2 mb-2')}
        >
          <ArrowLeftIcon className="size-4" />
          {t('title')}
        </Link>
        <PageHeader title={t('createTitle')} description={t('createSubtitle')} />
      </div>

      <Card>
        <CardContent className="pt-6">
          <CreateUserForm outlets={outlets} departments={departments} />
        </CardContent>
      </Card>
    </div>
  )
}
