import { getTranslations } from 'next-intl/server'
import { requirePermission } from '@/lib/auth/guards'
import { listPendingRegistrations } from '@/server/actions/users'
import { listOutletsForRegistration, listDepartmentsForRegistration } from '@/server/actions/org'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PageHeader } from '@/components/ui/page-header'
import { UsersTabs } from '@/components/team/users-tabs'
import { ApprovalRow } from './approval-row'

/**
 * /users/approvals — registration approvals, as a tab of the Users section.
 *
 * This page lived at /approvals with its own sidebar entry; it is the same
 * work as the directory next to it — deciding who is in the building and what
 * they may see — so it now sits behind the same nav item, the way Generate
 * and Exam History share Papers. The old address redirects here.
 */
export default async function ApprovalsPage() {
  // Enforced again here even though nav hides the link and middleware gates the
  // route. Hiding a link is presentation; this is the check that matters.
  await requirePermission('users.approve')
  const t = await getTranslations('users')

  const [registrations, outlets, departments] = await Promise.all([
    listPendingRegistrations(),
    listOutletsForRegistration(),
    listDepartmentsForRegistration(),
  ])

  return (
    <div className="space-y-6">
      <PageHeader title={t('approvalsTitle')} description={t('approvalsSubtitle')} />
      <UsersTabs />

      <Card>
        <CardHeader>
          <CardTitle>
            {t('approvalsPending')}
            {registrations.length > 0 && ` (${registrations.length})`}
          </CardTitle>
          <CardDescription>{t('approvalsOldest')}</CardDescription>
        </CardHeader>
        <CardContent>
          {registrations.length === 0 ? (
            <p className="py-8 text-center text-sm text-muted-foreground">
              {t('approvalsEmpty')}
            </p>
          ) : (
            /* One card per applicant — see the box in approval-row.tsx for why
               the table died. The list element keeps it announced as a list. */
            <ul className="space-y-4">
              {registrations.map((r) => (
                <ApprovalRow
                  key={r.id}
                  registration={r}
                  outlets={outlets}
                  departments={departments}
                />
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
