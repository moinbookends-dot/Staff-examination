'use client'

import { useEffect, useRef, useState, useTransition } from 'react'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/lib/i18n/navigation'
import { toast } from 'sonner'
import {
  bulkPublishQuestions,
  bulkSetQuestionsDeleted,
  bulkUpdateQuestions,
  resolveFilterToIds,
} from '@/server/actions/question-bulk'
import type { BulkOutcome } from '@/lib/questions/bulk'
import { QUESTION_STATUSES, isDrawableStatus } from '@/lib/questions/status'
import { useQuestionSelection } from './selection-provider'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Trash2Icon, UndoIcon, UploadIcon, XIcon } from 'lucide-react'

/**
 * What you can do to a selection.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THIS TOOLBAR DECIDES NOTHING.                                             │
 * │                                                                           │
 * │ It collects ids and calls the actions in server/actions/question-bulk.ts, │
 * │ which check permission and then hand the work to 0042's SECURITY INVOKER  │
 * │ RPCs under RLS. The `can*` props below hide buttons that would fail — a   │
 * │ courtesy, not a control. Every one of them is re-checked on the server,   │
 * │ and a row the caller may not touch comes back reported as skipped.        │
 * │                                                                           │
 * │ Which is why the result rendering matters as much as the buttons: an      │
 * │ action that quietly applies to 180 of 200 rows and says "Done" is worse   │
 * │ than one that fails outright.                                             │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

type Pending =
  | { kind: 'publish' }
  | { kind: 'remove' }
  | { kind: 'restore' }
  | { kind: 'status'; status: string }
  | null

export function BulkToolbar({
  canUpdate,
  canRetire,
  inBin,
}: {
  canUpdate: boolean
  canRetire: boolean
  /** The recycle-bin view offers Restore instead of everything else. */
  inBin: boolean
}) {
  const t = useTranslations('questions')
  const selection = useQuestionSelection()
  const params = useSearchParams()
  const router = useRouter()
  const [pending, setPending] = useState<Pending>(null)
  const [busy, startTransition] = useTransition()
  const ref = useRef<HTMLDivElement>(null)

  const count = selection.count

  /**
   * Move focus here when the bar appears.
   *
   * Selecting a row with the keyboard otherwise leaves focus in the table while
   * a new set of controls materialises somewhere else on the screen — a screen
   * reader user is told nothing, and finding the Publish button means tabbing
   * backwards past every row above.
   */
  const wasEmpty = useRef(true)
  useEffect(() => {
    if (wasEmpty.current && count > 0) ref.current?.focus()
    wasEmpty.current = count === 0
  }, [count])

  if (count === 0) return null

  const ids = [...selection.selected]

  function report(outcome: BulkOutcome) {
    if (!outcome.ok) {
      toast.error(outcome.error ?? t('bulk.failed'))
      return
    }
    // Never a bare "Done". Applied AND skipped, because a bulk action that
    // touched 180 of the 200 rows somebody selected has to say which.
    const parts = [t('bulk.applied', { count: outcome.applied.length })]
    if (outcome.skipped.length > 0) {
      parts.push(t('bulk.skipped', { count: outcome.skipped.length }))
    }
    const message = parts.join(' · ')
    if (outcome.applied.length === 0) toast.warning(message)
    else toast.success(message)

    if (outcome.applied.length > 0) {
      selection.clear()
      router.refresh()
    }
  }

  const run = (work: () => Promise<BulkOutcome>) => {
    startTransition(async () => {
      report(await work())
      setPending(null)
    })
  }

  /** "Select all 340 matching" — resolved through the same predicates the list uses. */
  const selectAllMatching = () => {
    startTransition(async () => {
      const result = await resolveFilterToIds(Object.fromEntries(params.entries()))
      selection.selectMany(result.ids)
      selection.setFilterWide(true)
      selection.setMatchedTotal(result.total)
      // The cap is REPORTED, not silently applied. Somebody who asked for 4,212
      // and got 1,000 has to be told, or they will believe the rest were done.
      if (result.capped) {
        toast.warning(t('bulk.capped', { limit: selection.limit, total: result.total }))
      }
    })
  }

  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="region"
      aria-label={t('bulk.selected', { count })}
      className="sticky top-14 z-20 -mx-4 flex flex-wrap items-center gap-2 border-y bg-background px-4 py-2 lg:-mx-6 lg:px-6"
    >
      {/* polite, not assertive: the count changes on every click, and assertive
          would interrupt whatever the person is reading each time. */}
      <span aria-live="polite" className="text-sm font-medium">
        {t('bulk.selected', { count })}
      </span>

      {!selection.isFilterWide && (
        <Button variant="ghost" size="sm" onClick={selectAllMatching} disabled={busy}>
          {t('bulk.selectAllMatching', { total: selection.matchedTotal ?? '' })}
        </Button>
      )}

      <div className="flex-1" />

      {inBin
        ? canRetire && (
            <Button size="sm" variant="outline" onClick={() => setPending({ kind: 'restore' })} disabled={busy}>
              <UndoIcon />
              {t('bulk.restore')}
            </Button>
          )
        : (
          <>
            {canUpdate && (
              <>
                <Button size="sm" onClick={() => setPending({ kind: 'publish' })} disabled={busy}>
                  <UploadIcon />
                  {t('bulk.publish')}
                </Button>

                <label className="sr-only" htmlFor="bulk-status">
                  {t('bulk.setStatus')}
                </label>
                <select
                  id="bulk-status"
                  value=""
                  disabled={busy}
                  onChange={(event) => {
                    if (event.target.value) setPending({ kind: 'status', status: event.target.value })
                  }}
                  className="h-8 rounded-md border border-input bg-transparent px-2 text-sm disabled:opacity-50"
                >
                  <option value="">{t('bulk.setStatus')}</option>
                  {/*
                   * Drawable statuses are absent on purpose. Making a question
                   * live runs the publish gate, and bulkUpdateQuestions refuses
                   * them outright — offering them here would put a button on the
                   * screen whose only outcome is an error message.
                   */}
                  {QUESTION_STATUSES.filter((status) => !isDrawableStatus(status)).map((status) => (
                    <option key={status} value={status}>
                      {t(`status.${status}`)}
                    </option>
                  ))}
                </select>
              </>
            )}

            {canRetire && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setPending({ kind: 'remove' })}
                disabled={busy}
              >
                <Trash2Icon />
                {t('bulk.remove')}
              </Button>
            )}
          </>
        )}

      <Button variant="ghost" size="sm" onClick={selection.clear} disabled={busy}>
        <XIcon />
        {t('bulk.clear')}
      </Button>

      <AlertDialog open={pending !== null} onOpenChange={(open) => !open && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pending?.kind === 'remove' && t('bulk.confirmRemoveTitle', { count })}
              {pending?.kind === 'restore' && t('bulk.confirmRestoreTitle', { count })}
              {pending?.kind === 'publish' && t('bulk.confirmPublishTitle', { count })}
              {pending?.kind === 'status' && t('bulk.statusTitle', { count })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {pending?.kind === 'remove' && t('bulk.confirmRemoveBody')}
              {pending?.kind === 'restore' && t('bulk.confirmRestoreBody')}
              {pending?.kind === 'publish' && t('bulk.confirmPublishBody')}
              {pending?.kind === 'status' && t('bulk.statusBody')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t('bulk.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={busy}
              onClick={(event) => {
                // The dialog closes on action by default; these are awaited, so
                // it has to stay open until the server answers.
                event.preventDefault()
                if (!pending) return
                if (pending.kind === 'publish') return run(() => bulkPublishQuestions({ ids }))
                if (pending.kind === 'remove')
                  return run(() => bulkSetQuestionsDeleted({ ids, deleted: true }))
                if (pending.kind === 'restore')
                  return run(() => bulkSetQuestionsDeleted({ ids, deleted: false }))
                return run(() => bulkUpdateQuestions({ ids, status: pending.status }))
              }}
            >
              {busy ? t('bulk.working') : t('bulk.applyTo', { count })}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
