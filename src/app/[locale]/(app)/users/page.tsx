import { getTranslations } from 'next-intl/server'
import { requireAnyPermission } from '@/lib/auth/guards'
import { listUsers, listRoles } from '@/server/actions/monitoring'
import { UsersTable } from '@/components/team/users-table'
import { PageHeader } from '@/components/ui/page-header'
import { Card, CardContent } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { UsersIcon } from 'lucide-react'

/**
 * /users — the people directory.
 *
 * Reach is admin_list_users()'s decision (0093): company always, own outlet
 * unless the caller holds users.read_all. The guard here is the legible fast
 * fail; an Employee typing this URL is refused by both layers.
 */
export default async function UsersPage() {
  await requireAnyPermission(['users.read_team', 'users.read_all'])
  const t = await getTranslations('users')

  const [rows, roles] = await Promise.all([listUsers(), listRoles()])
  const roleNames = Object.fromEntries(roles.map((r) => [r.role_key, r.role_name]))

  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('subtitle')} />

      {rows.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState icon={UsersIcon} message={t('empty')} />
          </CardContent>
        </Card>
      ) : (
        <UsersTable rows={rows} roleNames={roleNames} />
      )}
    </div>
  )
}
