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
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE HALF-MADE CHOICE IS PART OF THE VALUE, NOT PRIVATE STATE.             ║
 * ║                                                                           ║
 * ║ Picking "Role · Employee" and pressing Save used to assign NOBODY. The    ║
 * ║ two dropdowns were local state that only `add()` ever read, so a choice   ║
 * ║ made but not Added was invisible to the parent — which then saved the     ║
 * ║ list without it and reported success. Publishing did the same thing, and  ║
 * ║ there it is worse: the exam goes live, reaches no one, and the only clue  ║
 * ║ is a warning on a page nobody has a reason to revisit.                    ║
 * ║                                                                           ║
 * ║ So `pending` is lifted to the caller and withPending() folds it in at     ║
 * ║ submit. A selection the reader can SEE is a selection that counts, and    ║
 * ║ the failure is structurally gone rather than warned about — the parent    ║
 * ║ cannot save the list without also holding the unadded choice.             ║
 * ║                                                                           ║
 * ║ "+ Add" stays. It is how several targets get chosen and it is where the   ║
 * ║ duplicate is refused; it is simply no longer the only way a choice is     ║
 * ║ kept.                                                                     ║
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

/** What the two dropdowns are showing but the reader has not Added yet. */
export interface PendingSelection {
  kind: AssignmentTarget
  /** '' while the "Which" dropdown is still on its placeholder. */
  value: string
}

/** Outlet first, nothing chosen — the state both callers start in. */
export const NO_PENDING: PendingSelection = { kind: 'outlet', value: '' }

/** A pending selection as a row, or null when nothing is chosen. */
export function pendingRow(pending: PendingSelection): AssignmentRow | null {
  if (!pending.value) return null

  return {
    target_kind: pending.kind,
    target_id: pending.kind === 'role' || pending.kind === 'user' ? null : pending.value,
    target_role: pending.kind === 'role' ? pending.value : null,
    target_user_id: pending.kind === 'user' ? pending.value : null,
  }
}

/**
 * The rows to actually save: what was Added, plus what is still on screen.
 *
 * EVERY submit path must go through this. A duplicate is dropped rather than
 * appended — it is already in `rows`, so folding it in again would only trip
 * the unique index to no purpose.
 */
export function withPending(rows: AssignmentRow[], pending: PendingSelection): AssignmentRow[] {
  const row = pendingRow(pending)
  if (!row) return rows

  const already = rows.some(
    (r) => r.target_kind === row.target_kind && assignmentValue(r) === assignmentValue(row),
  )

  return already ? rows : [...rows, row]
}

const selectClass =
  'h-9 rounded-md border border-input bg-transparent px-2 text-sm disabled:opacity-50'

export function AssignmentPicker({
  rows,
  onChange,
  pending,
  onPendingChange,
  options,
  disabled = false,
  readOnly = false,
}: {
  rows: AssignmentRow[]
  onChange: (rows: AssignmentRow[]) => void
  /** Held by the caller so submitting can fold it in — see the box above. */
  pending: PendingSelection
  onPendingChange: (pending: PendingSelection) => void
  options: DirectoryOptions
  disabled?: boolean
  /** Show the chosen audience but offer no controls. */
  readOnly?: boolean
}) {
  const t = useTranslations('exams.assign')
  const { kind, value } = pending
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
    onChange(withPending(rows, pending))
    onPendingChange({ kind, value: '' })
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
              onChange={(e) =>
                onPendingChange({ kind: e.target.value as AssignmentTarget, value: '' })
              }
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
              onChange={(e) => onPendingChange({ kind, value: e.target.value })}
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
