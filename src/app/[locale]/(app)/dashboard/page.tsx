import { getTranslations } from 'next-intl/server'
import { requireApproved } from '@/lib/auth/guards'
import { can } from '@/lib/auth/claims'
import { listPendingRegistrations } from '@/server/actions/users'
import { Link } from '@/lib/i18n/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'

/**
 * Role-routed dashboard.
 *
 * One route, different content by permission, rather than /chef/dashboard and
 * /employee/dashboard. Users hold multiple roles (a chef who also does HR
 * reporting), so splitting by role would force an arbitrary choice about which
 * dashboard such a person lands on.
 *
 * SKELETON: the tiles here are the ones M1 can actually populate. Exam,
 * evaluation and skill-radar tiles arrive with M4–M6 rather than being
 * stubbed with fake numbers now — a dashboard showing invented data is worse
 * than one showing less.
 */
export default async function DashboardPage() {
  const claims = await requireApproved()
  const t = await getTranslations('nav')

  const canApprove = can(claims, 'users.approve')
  const pending = canApprove ? await listPendingRegistrations() : []

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('dashboard')}</h1>
        <p className="text-sm text-muted-foreground">
          {claims.roles.length > 0 ? claims.roles.join(' · ') : 'No role assigned'}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {canApprove && (
          <Link href="/approvals" className="block">
            <Card className="transition-colors hover:bg-accent/40">
              <CardHeader>
                <CardTitle className="flex items-center justify-between text-base">
                  {t('approvals')}
                  {pending.length > 0 && <Badge>{pending.length}</Badge>}
                </CardTitle>
                <CardDescription>
                  {pending.length === 0
                    ? 'Nothing waiting'
                    : `${pending.length} registration${pending.length === 1 ? '' : 's'} to review`}
                </CardDescription>
              </CardHeader>
            </Card>
          </Link>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Your details</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1 text-sm text-muted-foreground">
            <p>Roles: {claims.roles.join(', ') || '—'}</p>
            <p>Permissions: {claims.perms.length}</p>
          </CardContent>
        </Card>
      </div>
    </div>
  )
}
