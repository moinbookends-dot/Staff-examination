import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { requireAnyPermission } from '@/lib/auth/guards'
import { can } from '@/lib/auth/claims'
import { Link } from '@/lib/i18n/navigation'
import { createClient } from '@/lib/supabase/server'
import { dbId } from '@/lib/db/id'
import { listUsers, listRoles, getCandidateHistory } from '@/server/actions/monitoring'
import {
  listOutletsForRegistration,
  listDepartmentsForRegistration,
} from '@/server/actions/org'
import { PerformancePanel } from '@/components/team/performance-panel'
import { AccessForm } from '@/components/team/access-form'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { ArrowLeftIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * One person: who they are, what they may do, and every exam they sat.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THREE LAYERS, THREE GATES, ALL PRE-EXISTING:                              ║
 * ║   · the profile row — admin_list_users() reach (users.read_team/all)      ║
 * ║   · the exam history — candidate_attempt_history() against 0030's         ║
 * ║     analytics_scope, so a users.read_team holder without reports scope    ║
 * ║     sees the person but an empty record, which is the permission model    ║
 * ║     telling the truth                                                     ║
 * ║   · the access form — rendered only for holders of users.assign_roles     ║
 * ║     (the super-admin bypass), and set_user_access() re-checks server-side ║
 * ║                                                                           ║
 * ║ Every history row and every chart point opens /monitoring/[attemptId] —   ║
 * ║ THE one paper viewer, same as the live-exam participant table.            ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */
export default async function UserDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const claims = await requireAnyPermission(['users.read_team', 'users.read_all'])
  const { id } = await params
  const t = await getTranslations('users')
  const tp = await getTranslations('perf')

  const parsed = dbId().safeParse(id)
  if (!parsed.success) notFound()

  // The reach-checked row for this person — absent and out-of-reach are one.
  const rows = await listUsers()
  const person = rows.find((r) => r.user_id === parsed.data)
  if (!person) notFound()

  const canManage = can(claims, 'users.assign_roles')

  const [history, roles, departments, outlets, rolePerms] = await Promise.all([
    getCandidateHistory(parsed.data),
    canManage ? listRoles() : Promise.resolve([]),
    canManage ? listDepartmentsForRegistration() : Promise.resolve([]),
    canManage ? listOutletsForRegistration() : Promise.resolve([]),
    canManage ? loadRolePermissions() : Promise.resolve({}),
  ])

  // The speciality role drives the dropdown; 'employee' is the ever-present base.
  const primaryRole =
    person.role_keys.find((k) => k !== 'employee') ?? person.role_keys[0] ?? 'employee'

  // Ids for the form's current selection, read under the caller's own RLS.
  const supabase = await createClient()
  const { data: place } = await supabase
    .from('profiles')
    .select('department_id, outlet_id')
    .eq('id', parsed.data)
    .maybeSingle()

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/users"
          className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), '-ml-2 mb-2')}
        >
          <ArrowLeftIcon className="size-4" />
          {t('title')}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          {person.full_name || person.email}
        </h1>
        <p className="text-sm text-muted-foreground">
          {[person.employee_code, person.department, person.outlet]
            .filter(Boolean)
            .join(' · ') || person.email}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {person.role_keys.map((k) => (
            <Badge key={k} variant="secondary">{k}</Badge>
          ))}
          <Badge variant="outline">{person.approval_status}</Badge>
        </div>
      </div>

      {canManage && (
        <section className="rounded-xl border bg-card p-5">
          <h2 className="text-title-md">{t('manageAccess')}</h2>
          <div className="mt-4">
            <AccessForm
              userId={person.user_id}
              currentRoleKey={primaryRole}
              currentDepartmentId={place?.department_id ?? null}
              currentOutletId={place?.outlet_id ?? null}
              roles={roles}
              departments={departments}
              outlets={outlets}
              rolePermissions={rolePerms}
            />
          </div>
        </section>
      )}

      <section className="space-y-4">
        <h2 className="text-title-md">{tp('title')}</h2>
        <PerformancePanel rows={history} />
      </section>
    </div>
  )
}

/** role_key → permission keys, for the read-only summary in the access form. */
async function loadRolePermissions(): Promise<Record<string, string[]>> {
  const supabase = await createClient()
  const { data } = await supabase
    .from('roles')
    .select('key, role_permissions(permissions(key))')

  const map: Record<string, string[]> = {}
  for (const row of (data ?? []) as unknown as Array<{
    key: string
    role_permissions: Array<{ permissions: { key: string } | null }>
  }>) {
    map[row.key] = row.role_permissions
      .map((rp) => rp.permissions?.key)
      .filter((k): k is string => !!k)
      .sort()
  }
  return map
}
