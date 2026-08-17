'use client'

import { useState, useTransition } from 'react'
import { useRouter } from '@/lib/i18n/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { setAssignments } from '@/server/actions/exams'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  AssignmentPicker,
  NO_PENDING,
  toAssignmentInput,
  withPending,
  type AssignmentRow,
  type DirectoryOptions,
  type PendingSelection,
} from './assignment-picker'

/**
 * Who sits this exam — changing it after the exam already exists.
 *
 * ASSIGNMENTS STAY EDITABLE AFTER PUBLISH. The 0016 lock covers content — what
 * is asked and how it scores — not the audience. Adding an outlet that opened
 * late, or giving one person a retake, changes nothing about the paper and is
 * exactly the kind of thing that happens after an exam goes out.
 *
 * The picker itself lives in ./assignment-picker so PublishPaper can use it
 * before there is an exam to attach anything to. This component is only the
 * save half.
 */

export type { AssignmentRow } from './assignment-picker'

export function ExamAssignments({
  examId,
  initial,
  options,
  canAssign,
}: {
  examId: string
  initial: AssignmentRow[]
  options: DirectoryOptions
  canAssign: boolean
}) {
  const router = useRouter()
  const t = useTranslations('exams.assign')
  const [pending, startTransition] = useTransition()
  const [rows, setRows] = useState<AssignmentRow[]>(initial)
  const [selection, setSelection] = useState<PendingSelection>(NO_PENDING)
  const [error, setError] = useState<string | null>(null)

  function save() {
    setError(null)

    /*
     * A choice still sitting in the dropdowns counts. Saving `rows` alone is
     * what let "Role · Employee" be picked, saved, confirmed — and assigned to
     * nobody. The state is updated too, so the badge appears rather than the
     * row arriving only after the refresh.
     */
    const toSave = withPending(rows, selection)
    setRows(toSave)
    setSelection({ kind: selection.kind, value: '' })

    startTransition(async () => {
      const result = await setAssignments({ examId, assignments: toAssignmentInput(toSave) })
      if (!result.ok) {
        setError(result.error ?? 'Could not save the assignments.')
        return
      }
      toast.success(t('saved'))
      router.refresh()
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
        <CardDescription>{t('description')}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && <InlineError>{error}</InlineError>}

        <AssignmentPicker
          rows={rows}
          onChange={setRows}
          pending={selection}
          onPendingChange={setSelection}
          options={options}
          disabled={pending}
          readOnly={!canAssign}
        />

        {canAssign && (
          <Button onClick={save} disabled={pending}>
            {t('save')}
          </Button>
        )}
      </CardContent>
    </Card>
  )
}
