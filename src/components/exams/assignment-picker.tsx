'use client'

import { useState } from 'react'
import { useTranslations } from 'next-intl'
import { PlusIcon, XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { InlineError } from '@/components/ui/inline-error'
import { ASSIGNMENT_TARGETS, type AssignmentTarget } from '@/lib/exams/rules'
import type { DirectoryOption, PersonOption } from '@/server/actions/directory'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Choosing who sits an exam — the picker only, with no idea how to save.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ SPLIT OUT OF ExamAssignments SO PUBLISHING CAN USE IT BEFORE AN EXAM      ║
 * ║ EXISTS.                                                                   ║
 * ║                                                                           ║
 * ║ The audience used to be chosen only AFTER publishing, on a separate page, ║
 * ║ because setAssignments needs an examId and there is no exam until the     ║
 * ║ paper is published. That is why publishing left an exam nobody could see  ║
 * ║ and the paper page had to carry a "nobody has been chosen yet" warning.   ║
 * ║                                                                           ║
 * ║ This component is CONTROLLED and stateless about persistence: it takes    ║
 * ║ rows and hands back rows. PublishPaper holds them until it has an exam    ║
 * ║ id; ExamAssignments saves them straight away. One picker, two moments.    ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Five target kinds. Four are groups; the fifth names one person, which exists
 * so a retake does not mean raising max_attempts for everybody who already
 * passed.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface AssignmentRow {
  id?: string
  target_kind: AssignmentTarget
  target_id: string | null
  target_role: string | null
  target_user_id: string | null
}

export interface DirectoryOptions {
  outlets: DirectoryOption[]
  departments: DirectoryOption[]
  brands: DirectoryOption[]
  roles: DirectoryOption[]
  people: PersonOption[]
}

/** The value column differs by kind — see the assignment_target_shape CHECK. */
export function assignmentValue(row: AssignmentRow): string | null {
  return row.target_kind === 'role'
    ? row.target_role
    : row.target_kind === 'user'
      ? row.target_user_id
      : row.target_id
}

/** The shape setAssignments expects, from the shape the database returns. */
export function toAssignmentInput(rows: AssignmentRow[]) {
  return rows.map((r) => ({
    targetKind: r.target_kind,
    targetId: r.target_id,
    targetRole: r.target_role,
    targetUserId: r.target_user_id,
  }))
}

const selectClass =
  'h-9 rounded-md border border-input bg-transparent px-2 text-sm disabled:opacity-50'

export function AssignmentPicker({
  rows,
  onChange,
  options,
  disabled = false,
  readOnly = false,
}: {
  rows: AssignmentRow[]
  onChange: (rows: AssignmentRow[]) => void
  options: DirectoryOptions
  disabled?: boolean
  /** Show the chosen audience but offer no controls. */
  readOnly?: boolean
}) {
  const t = useTranslations('exams.assign')
  const [kind, setKind] = useState<AssignmentTarget>('outlet')
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)

  const optionsFor = (target: AssignmentTarget): DirectoryOption[] => {
    switch (target) {
      case 'outlet':
        return options.outlets
      case 'department':
        return options.departments
      case 'brand':
        return options.brands
      case 'role':
        return options.roles
      case 'user':
        return options.people.map((p) => ({ id: p.id, name: `${p.name} · ${p.email}` }))
    }
  }

  const labelFor = (row: AssignmentRow) => {
    const id = assignmentValue(row)
    return optionsFor(row.target_kind).find((o) => o.id === id)?.name ?? id ?? '—'
  }

  function add() {
    if (!value) return

    // Already assigned by this kind: silently adding a duplicate would hit the
    // unique index and surface as a database error for something the UI can
    // simply decline.
    if (rows.some((r) => r.target_kind === kind && assignmentValue(r) === value)) {
      setError(t('alreadyAssigned'))
      return
    }

    setError(null)
    onChange([
      ...rows,
      {
        target_kind: kind,
        target_id: kind === 'role' || kind === 'user' ? null : value,
        target_role: kind === 'role' ? value : null,
        target_user_id: kind === 'user' ? value : null,
      },
    ])
    setValue('')
  }

  return (
    <div className="space-y-4">
      {error && <InlineError>{error}</InlineError>}

      {rows.length === 0 ? (
        // Said plainly: an exam nobody is assigned to is not an error the
        // database will catch, and it silently reaches nobody.
        <p className="text-body-sm text-muted-foreground">{t('none')}</p>
      ) : (
        <ul className="flex flex-wrap gap-2">
          {rows.map((row, index) => (
            <li key={`${row.target_kind}-${assignmentValue(row)}-${index}`}>
              <Badge variant="secondary" className="gap-1">
                <span className="text-muted-foreground">{t(`kinds.${row.target_kind}`)}</span>
                {labelFor(row)}
                {!readOnly && (
                  <button
                    type="button"
                    aria-label={t('remove', { name: labelFor(row) })}
                    disabled={disabled}
                    onClick={() => onChange(rows.filter((_, i) => i !== index))}
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

      {!readOnly && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="space-y-1">
            <Label className="text-xs">{t('assignTo')}</Label>
            <select
              value={kind}
              onChange={(e) => {
                setKind(e.target.value as AssignmentTarget)
                setValue('')
              }}
              disabled={disabled}
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
              disabled={disabled}
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

          <Button type="button" variant="outline" onClick={add} disabled={disabled || !value}>
            <PlusIcon />
            {t('add')}
          </Button>
        </div>
      )}
    </div>
  )
}
