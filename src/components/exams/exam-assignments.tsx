'use client'

import { useState, useTransition } from 'react'
import { useRouter } from '@/lib/i18n/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { setAssignments } from '@/server/actions/exams'
import { ASSIGNMENT_TARGETS, type AssignmentTarget } from '@/lib/exams/rules'
import type { DirectoryOption, PersonOption } from '@/server/actions/directory'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { PlusIcon, XIcon } from 'lucide-react'

/**
 * Who sits this exam.
 *
 * ASSIGNMENTS STAY EDITABLE AFTER PUBLISH. The 0016 lock covers content — what
 * is asked and how it scores — not the audience. Adding an outlet that opened
 * late, or giving one person a retake, changes nothing about the paper and is
 * exactly the kind of thing that happens after an exam goes out.
 *
 * Five target kinds. Four are groups; the fifth names one person, which exists
 * so a retake does not mean raising max_attempts for everybody who already
 * passed.
 */

export interface AssignmentRow {
  id?: string
  target_kind: AssignmentTarget
  target_id: string | null
  target_role: string | null
  target_user_id: string | null
}

export function ExamAssignments({
  examId,
  initial,
  outlets,
  departments,
  brands,
  roles,
  people,
  canAssign,
}: {
  examId: string
  initial: AssignmentRow[]
  outlets: DirectoryOption[]
  departments: DirectoryOption[]
  brands: DirectoryOption[]
  roles: DirectoryOption[]
  people: PersonOption[]
  canAssign: boolean
}) {
  const router = useRouter()
  const t = useTranslations('exams.assign')
  const [pending, startTransition] = useTransition()
  const [rows, setRows] = useState<AssignmentRow[]>(initial)
  const [kind, setKind] = useState<AssignmentTarget>('outlet')
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  const optionsFor = (target: AssignmentTarget): DirectoryOption[] => {
    switch (target) {
      case 'outlet':
        return outlets
      case 'department':
        return departments
      case 'brand':
        return brands
      case 'role':
        return roles
      case 'user':
        return people.map((p) => ({ id: p.id, name: `${p.name} · ${p.email}` }))
    }
  }

  /** The value column differs by kind — see the assignment_target_shape CHECK. */
  const valueOf = (row: AssignmentRow) =>
    row.target_kind === 'role'
      ? row.target_role
      : row.target_kind === 'user'
        ? row.target_user_id
        : row.target_id

  const labelFor = (row: AssignmentRow) => {
    const id = valueOf(row)
    return optionsFor(row.target_kind).find((o) => o.id === id)?.name ?? id ?? '—'
  }

  function add() {
    if (!value) return
    // Already assigned by this kind: silently adding a duplicate would hit the
    // unique index and surface as a database error for something the UI can
    // simply decline.
    const exists = rows.some((r) => r.target_kind === kind && valueOf(r) === value)
    if (exists) {
      setError(t('alreadyAssigned'))
      return
    }
    setError(null)
    setRows((current) => [
      ...current,
      {
        target_kind: kind,
        target_id: kind === 'role' || kind === 'user' ? null : value,
        target_role: kind === 'role' ? value : null,
        target_user_id: kind === 'user' ? value : null,
      },
    ])
    setValue('')
  }

  function save() {
    setError(null)
    startTransition(async () => {
      const result = await setAssignments({
        examId,
        assignments: rows.map((r) => ({
          targetKind: r.target_kind,
          targetId: r.target_id,
          targetRole: r.target_role,
          targetUserId: r.target_user_id,
        })),
      })
      if (!result.ok) {
        setError(result.error ?? 'Could not save the assignments.')
        return
      }
      toast.success(t('saved'))
      router.refresh()
    })
  }

  const selectClass =
    'h-9 rounded-md border border-input bg-transparent px-2 text-sm disabled:opacity-50'

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <InlineError>{error}</InlineError>
        )}

        {rows.length === 0 ? (
          // Said plainly: a published exam nobody is assigned to is not an
          // error the database will catch, and it silently reaches nobody.
          <p className="text-sm text-muted-foreground">{t('none')}</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {rows.map((row, index) => (
              <li key={`${row.target_kind}-${valueOf(row)}-${index}`}>
                <Badge variant="secondary" className="gap-1">
                  <span className="text-muted-foreground">{t(`kinds.${row.target_kind}`)}</span>
                  {labelFor(row)}
                  {canAssign && (
                    <button
                      type="button"
                      aria-label={t('remove', { name: labelFor(row) })}
                      disabled={pending}
                      onClick={() => setRows((current) => current.filter((_, i) => i !== index))}
                      className="ml-1"
                    >
                      <XIcon className="size-3" />
                    </button>
                  )}
                </Badge>
              </li>
            ))}
          </ul>
        )}

        {canAssign && (
          <>
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1">
                <Label className="text-xs">{t('assignTo')}</Label>
                <select
                  value={kind}
                  onChange={(e) => {
                    setKind(e.target.value as AssignmentTarget)
                    setValue('')
                  }}
                  disabled={pending}
                  aria-label={t('assignTo')}
                  className={selectClass}
                >
                  {ASSIGNMENT_TARGETS.map((target) => (
                    <option key={target} value={target}>
                      {t(`kinds.${target}`)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="min-w-56 flex-1 space-y-1">
                <Label className="text-xs">{t('which')}</Label>
                <select
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  disabled={pending}
                  aria-label={t('which')}
                  className={`${selectClass} w-full`}
                >
                  <option value="">{t('choose')}</option>
                  {optionsFor(kind).map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </select>
              </div>

              <Button type="button" variant="outline" onClick={add} disabled={pending || !value}>
                <PlusIcon />
                {t('add')}
              </Button>
            </div>

            <Button onClick={save} disabled={pending}>
              {t('save')}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  )
}
