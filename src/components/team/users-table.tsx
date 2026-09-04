'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { ChevronRightIcon, SearchIcon } from 'lucide-react'
import { Link } from '@/lib/i18n/navigation'
import type { AdminUserRow } from '@/server/actions/monitoring'
import { Badge } from '@/components/ui/badge'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

/**
 * The Users directory — search and filters over rows the database already
 * scoped (admin_list_users: company always, outlet unless users.read_all).
 * Client-side filtering for the same sized reason as the participant table:
 * a company's staff is tens of rows, all already in hand.
 */

export function UsersTable({
  rows,
  roleNames,
}: {
  rows: AdminUserRow[]
  roleNames: Record<string, string>
}) {
  const t = useTranslations('users')
  const [search, setSearch] = useState('')
  const [role, setRole] = useState('all')
  const [department, setDepartment] = useState('all')
  const [outlet, setOutlet] = useState('all')
  const [status, setStatus] = useState('all')

  const departments = useMemo(
    () => [...new Set(rows.map((r) => r.department).filter((v): v is string => !!v))].sort(),
    [rows],
  )
  const outlets = useMemo(
    () => [...new Set(rows.map((r) => r.outlet).filter((v): v is string => !!v))].sort(),
    [rows],
  )
  const roles = useMemo(
    () => [...new Set(rows.flatMap((r) => r.role_keys))].sort(),
    [rows],
  )

  const shown = useMemo(() => {
    const needle = search.trim().toLowerCase()
    return rows.filter((r) => {
      if (needle) {
        const hay = `${r.full_name ?? ''} ${r.email} ${r.employee_code ?? ''}`.toLowerCase()
        if (!hay.includes(needle)) return false
      }
      if (role !== 'all' && !r.role_keys.includes(role)) return false
      if (department !== 'all' && r.department !== department) return false
      if (outlet !== 'all' && r.outlet !== outlet) return false
      if (status !== 'all' && r.approval_status !== status) return false
      return true
    })
  }, [rows, search, role, department, outlet, status])

  const statusTone = (s: string) =>
    s === 'approved'
      ? 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400'
      : s === 'pending'
        ? 'border-amber-500/40 text-amber-700 dark:text-amber-500'
        : 'border-destructive/40 text-destructive'

  const roleBadges = (r: AdminUserRow) =>
    // 'employee' is the base everyone holds; showing it beside a speciality is
    // noise. Alone, it is the role.
    (r.role_keys.length > 1 ? r.role_keys.filter((k) => k !== 'employee') : r.role_keys).map(
      (k) => (
        <Badge key={k} variant="secondary">
          {roleNames[k] ?? k}
        </Badge>
      ),
    )

  const select = 'min-h-11 rounded-md border border-input bg-transparent px-2 text-sm'

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-center">
        <div className="relative flex-1">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            aria-label={t('search')}
            placeholder={t('search')}
            className="min-h-11 w-full rounded-md border border-input bg-transparent pr-3 pl-9 text-sm"
          />
        </div>
        <div className="flex flex-wrap gap-2">
          <select value={role} onChange={(e) => setRole(e.target.value)} aria-label={t('role')} className={select}>
            <option value="all">{t('allRoles')}</option>
            {roles.map((k) => (
              <option key={k} value={k}>{roleNames[k] ?? k}</option>
            ))}
          </select>
          <select value={department} onChange={(e) => setDepartment(e.target.value)} aria-label={t('department')} className={select}>
            <option value="all">{t('allDepartments')}</option>
            {departments.map((d) => (
              <option key={d} value={d}>{d}</option>
            ))}
          </select>
          <select value={outlet} onChange={(e) => setOutlet(e.target.value)} aria-label={t('outlet')} className={select}>
            <option value="all">{t('allOutlets')}</option>
            {outlets.map((o) => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
          <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label={t('status')} className={select}>
            <option value="all">{t('allStatuses')}</option>
            <option value="approved">{t('statusApproved')}</option>
            <option value="pending">{t('statusPending')}</option>
            <option value="rejected">{t('statusRejected')}</option>
          </select>
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">{t('noMatch')}</p>
      ) : (
        <>
          {/* Phones: tap-through cards. */}
          <ul className="space-y-3 md:hidden">
            {shown.map((r) => (
              <li key={r.user_id} className="rounded-lg border">
                <Link href={`/users/${r.user_id}`} className="block p-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate font-medium">{r.full_name || r.email}</p>
                      <p className="truncate text-sm text-muted-foreground">
                        {[r.employee_code, r.department, r.outlet].filter(Boolean).join(' · ') ||
                          r.email}
                      </p>
                    </div>
                    <ChevronRightIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {roleBadges(r)}
                    <Badge variant="outline" className={cn(statusTone(r.approval_status))}>
                      {r.approval_status === 'approved'
                        ? t('statusApproved')
                        : r.approval_status === 'pending'
                          ? t('statusPending')
                          : t('statusRejected')}
                    </Badge>
                  </div>
                </Link>
              </li>
            ))}
          </ul>

          {/* md and up: the table. */}
          <div className="hidden md:block">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('person')}</TableHead>
                  <TableHead>{t('employeeId')}</TableHead>
                  <TableHead>{t('role')}</TableHead>
                  <TableHead>{t('department')}</TableHead>
                  <TableHead>{t('outlet')}</TableHead>
                  <TableHead>{t('status')}</TableHead>
                  <TableHead className="w-0" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {shown.map((r) => (
                  <TableRow key={r.user_id}>
                    <TableCell>
                      <Link href={`/users/${r.user_id}`} className="font-medium text-primary hover:underline">
                        {r.full_name || r.email}
                      </Link>
                      <span className="block text-xs text-muted-foreground">{r.email}</span>
                    </TableCell>
                    <TableCell className="tabular-nums text-muted-foreground">
                      {r.employee_code ?? '—'}
                    </TableCell>
                    <TableCell>
                      <span className="flex flex-wrap gap-1">{roleBadges(r)}</span>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{r.department ?? '—'}</TableCell>
                    <TableCell className="text-muted-foreground">{r.outlet ?? '—'}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={cn(statusTone(r.approval_status))}>
                        {r.approval_status === 'approved'
                          ? t('statusApproved')
                          : r.approval_status === 'pending'
                            ? t('statusPending')
                            : t('statusRejected')}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/users/${r.user_id}`}
                        className="text-sm font-medium text-primary hover:underline"
                      >
                        {t('view')}
                      </Link>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </>
      )}
    </div>
  )
}
