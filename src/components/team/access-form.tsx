'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { setUserAccess } from '@/server/actions/monitoring'
import type { OrgOption } from '@/server/actions/org'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { InlineError } from '@/components/ui/inline-error'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Manage access — role, department, outlet.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE ROLES IN THE DROPDOWN ARE THE DATABASE'S ROLES, passed down from      ║
 * ║ list_roles() — nothing here invents or hardcodes one. Saving calls        ║
 * ║ set_user_access() (0093), where every rule that matters lives:            ║
 * ║ super-admin-only, never your own row, never the last super admin. A       ║
 * ║ forged request from the console hits the same wall this form does.        ║
 * ║                                                                           ║
 * ║ Nothing saves without the explicit press of Save — no auto-persist on     ║
 * ║ change, because access is exactly the kind of change that must never      ║
 * ║ happen because somebody brushed a dropdown on a phone.                    ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Permission display is the ROLE's permission set, read-only: this system has
 * no per-user permission overrides, and drawing editable checkboxes for
 * something the schema cannot store would be a lie waiting for a click.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export function AccessForm({
  userId,
  currentRoleKey,
  currentDepartmentId,
  currentOutletId,
  roles,
  departments,
  outlets,
  rolePermissions,
}: {
  userId: string
  currentRoleKey: string
  currentDepartmentId: string | null
  currentOutletId: string | null
  roles: Array<{ role_key: string; role_name: string }>
  departments: OrgOption[]
  outlets: OrgOption[]
  /** role_key → permission keys, for the read-only summary. */
  rolePermissions: Record<string, string[]>
}) {
  const t = useTranslations('users')
  const router = useRouter()
  const [pending, start] = useTransition()

  const [roleKey, setRoleKey] = useState(currentRoleKey)
  const [departmentId, setDepartmentId] = useState(currentDepartmentId ?? '')
  const [outletId, setOutletId] = useState(currentOutletId ?? '')
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const dirty =
    roleKey !== currentRoleKey ||
    (departmentId || null) !== currentDepartmentId ||
    (outletId || null) !== currentOutletId

  const save = () =>
    start(async () => {
      setError(null)
      setSaved(false)
      const result = await setUserAccess({
        userId,
        roleKey,
        departmentId: departmentId || null,
        outletId: outletId || null,
      })
      if (!result.ok) {
        setError(result.error ?? t('saveFailed'))
        return
      }
      setSaved(true)
      router.refresh()
    })

  const select = 'min-h-11 w-full rounded-md border border-input bg-transparent px-2 text-sm'
  const perms = rolePermissions[roleKey] ?? []

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-1.5">
          <Label htmlFor="access-role">{t('role')}</Label>
          <select
            id="access-role"
            value={roleKey}
            onChange={(e) => setRoleKey(e.target.value)}
            disabled={pending}
            className={select}
          >
            {roles.map((r) => (
              <option key={r.role_key} value={r.role_key}>{r.role_name}</option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="access-department">{t('department')}</Label>
          <select
            id="access-department"
            value={departmentId}
            onChange={(e) => setDepartmentId(e.target.value)}
            disabled={pending}
            className={select}
          >
            <option value="">—</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="access-outlet">{t('outlet')}</Label>
          <select
            id="access-outlet"
            value={outletId}
            onChange={(e) => setOutletId(e.target.value)}
            disabled={pending}
            className={select}
          >
            <option value="">—</option>
            {outlets.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        </div>
      </div>

      {/* What the chosen role can do — the role's own grant list, read-only. */}
      {perms.length > 0 && (
        <div>
          <p className="text-label-caps text-muted-foreground">{t('rolePermissions')}</p>
          <p className="mt-1 text-sm text-muted-foreground">{perms.join(' · ')}</p>
        </div>
      )}
      {roleKey === 'super_admin' && (
        <p className="text-sm text-muted-foreground">{t('superAdminAll')}</p>
      )}

      {error && <InlineError>{error}</InlineError>}
      {saved && !dirty && (
        <p role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
          {t('savedNote')}
        </p>
      )}

      <div className="flex items-center gap-3">
        <Button onClick={save} disabled={pending || !dirty} className="min-h-11 px-6">
          {t('save')}
        </Button>
        {dirty && <p className="text-sm text-muted-foreground">{t('unsavedNote')}</p>}
      </div>

      {/* The truth about latency, said up front rather than discovered. */}
      <p className="text-xs text-muted-foreground">{t('tokenNote')}</p>
    </div>
  )
}
