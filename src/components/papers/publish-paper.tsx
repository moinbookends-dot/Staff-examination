'use client'

import { useState, useTransition } from 'react'
import { useRouter } from '@/lib/i18n/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { MonitorPlayIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { InlineError } from '@/components/ui/inline-error'
import { cn } from '@/lib/utils'
 import {
  AssignmentPicker,
  toAssignmentInput,
  type AssignmentRow,
  type DirectoryOptions,
} from '@/components/exams/assignment-picker'
import type { PublishPaperResult } from '@/server/actions/papers'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Put a generated paper on screens.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ PUBLISHING NOW CHOOSES THE AUDIENCE TOO, AND THAT REVERSES A DELIBERATE   ║
 * ║ EARLIER DECISION.                                                         ║
 * ║                                                                           ║
 * ║ This form used to publish and then send the reader to /exams/[id], because ║
 * ║ that was the only screen able to write exam_assignments. The split was     ║
 * ║ defensible — an exam with no audience is invisible rather than open to     ║
 * ║ everyone — but it made the commonest outcome a half-finished job: the      ║
 * ║ exam went live, nobody was assigned, and it reached nobody.                ║
 * ║                                                                           ║
 * ║ The picker is now a step in this form, and the two writes happen in one    ║
 * ║ action. If the audience write fails the publish still stands and the       ║
 * ║ reader is told — the paper page keeps its "nobody chosen yet" warning as   ║
 * ║ the safety net.                                                           ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * A retired paper offers no form at all. 0063 refuses it, and rendering inputs
 * that lead only to an error message wastes the reader's time.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** <input type="datetime-local"> wants `YYYY-MM-DDTHH:mm` with no zone. */
function toIso(local: string): string | null {
  if (!local) return null
  const d = new Date(local)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export interface PublishPaperProps {
  paperId: string
  paperNo: number
  /** Marks and question count are equal — one mark per question, by product rule. */
  marks: number
  retired: boolean
  /**
   * The directory to choose an audience from. Absent for a caller who may
   * publish but not assign, in which case the audience step is not offered and
   * they finish on the paper page with the "nobody chosen yet" warning.
   */
  directory?: DirectoryOptions
  /** Present only for a caller holding both exams.create and exams.publish. */
  onPublish?: (input: {
    paperId: string
    title: string
    instructions: string
    durationMinutes: number
    maxAttempts: number
    passMarkPercent: number
    opensAt: string | null
    closesAt: string | null
    resultsRelease: 'immediate' | 'on_close'
    assignments: ReturnType<typeof toAssignmentInput>
  }) => Promise<PublishPaperResult>
  /** Where to go after publishing. Defaults to the paper's own page. */
  onPublished?: (examId: string) => void
}

/** <input type="datetime-local"> from a Date, in the reader's own zone. */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function PublishPaper({
  paperId,
  paperNo,
  marks,
  retired,
  directory,
  onPublish,
  onPublished,
}: PublishPaperProps) {
  const t = useTranslations('papers')
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const [title, setTitle] = useState(t('publishDefaultTitle', { no: paperNo }))
  const [instructions, setInstructions] = useState('')
  // Generous but not unbounded: a 20-mark paper in 30 minutes is the house
  // default, and 50 marks gets proportionally longer.
  const [duration, setDuration] = useState(marks >= 50 ? 60 : 30)
  const [attempts, setAttempts] = useState(1)
  const [passMark, setPassMark] = useState(60)
  const [opens, setOpens] = useState('')
  /*
   * A closing time is REQUIRED — 0064 refuses a paper-backed exam without one,
   * because without it "closed" never arrives and an on_close release never
   * fires. Prefilled a week out so the commonest case is one less thing to
   * type, and so the field is never submitted empty by accident.
   */
  const [closes, setCloses] = useState(() =>
    toLocalInput(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)),
  )
  const [release, setRelease] = useState<'immediate' | 'on_close'>('immediate')
  const [audience, setAudience] = useState<AssignmentRow[]>([])

  if (retired) {
    return <p className="text-body-sm text-muted-foreground">{t('publishRetired')}</p>
  }

  // No handler means the reader holds papers.read_history but not the exam
  // permissions. Showing a disabled form would imply the action is theirs.
  if (!onPublish) {
    return <p className="text-body-sm text-muted-foreground">{t('publishNotPermitted')}</p>
  }

  const submit = () => {
    setError(null)

    /*
     * ┌───────────────────────────────────────────────────────────────────────┐
     * │ THESE MIRROR 0064'S CHECKS. THEY DO NOT REPLACE THEM.                 │
     * │                                                                       │
     * │ publish_paper_as_exam validates the whole configuration again and      │
     * │ raises, because a Server Action is a public endpoint and this form is  │
     * │ a courtesy to the person typing. What these buy is a message beside    │
     * │ the field instead of a round trip.                                     │
     * └───────────────────────────────────────────────────────────────────────┘
     */
    if (!title.trim()) {
      setError(t('publishNeedsTitle'))
      return
    }
    if (!closes) {
      setError(t('publishNeedsDeadline'))
      return
    }
    const closesIso = toIso(closes)
    const opensIso = toIso(opens)
    if (!closesIso) {
      setError(t('publishNeedsDeadline'))
      return
    }
    if (opensIso && closesIso <= opensIso) {
      setError(t('publishDeadlineBeforeStart'))
      return
    }
    if (new Date(closesIso).getTime() <= Date.now()) {
      setError(t('publishDeadlinePast'))
      return
    }

    startTransition(async () => {
      const result = await onPublish({
        paperId,
        title: title.trim(),
        instructions: instructions.trim(),
        durationMinutes: duration,
        maxAttempts: attempts,
        passMarkPercent: passMark,
        opensAt: opensIso,
        closesAt: closesIso,
        resultsRelease: release,
        assignments: toAssignmentInput(audience),
      })

      if (!result.ok) {
        setError(result.message)
        return
      }

      /*
       * The exam published. If only the audience failed to save, say so rather
       * than celebrating — the paper page will show the "nobody chosen yet"
       * warning and the picker to fix it.
       */
      if (result.assignmentError) {
        toast.warning(t('publishedButNotAssigned'))
      } else {
        toast.success(t('publishDone', { no: result.paperNo }))
      }

      /*
       * Stay with the paper. This used to push to /exams/[id] because that was
       * the only place an audience could be chosen; the picker above removed
       * that reason, and the paper's own page now carries the exam, its
       * audience and its participation.
       */
      if (onPublished) onPublished(result.examId)
      else router.refresh()
    })
  }

  return (
    <div className="space-y-4">
      {error && <InlineError>{error}</InlineError>}

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Label htmlFor="publish-title">{t('publishTitleLabel')}</Label>
          <Input
            id="publish-title"
            value={title}
            maxLength={200}
            disabled={pending}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        <div>
          <Label htmlFor="publish-duration">{t('publishDuration')}</Label>
          <Input
            id="publish-duration"
            type="number"
            min={5}
            max={480}
            value={duration}
            disabled={pending}
            onChange={(e) => setDuration(Number(e.target.value))}
          />
        </div>

        <div>
          <Label htmlFor="publish-pass">{t('publishPassMark')}</Label>
          <Input
            id="publish-pass"
            type="number"
            min={1}
            max={100}
            value={passMark}
            disabled={pending}
            onChange={(e) => setPassMark(Number(e.target.value))}
          />
        </div>

        <div>
          <Label htmlFor="publish-attempts">{t('publishAttempts')}</Label>
          <Input
            id="publish-attempts"
            type="number"
            min={1}
            max={10}
            value={attempts}
            disabled={pending}
            onChange={(e) => setAttempts(Number(e.target.value))}
          />
        </div>

        <div>
          <Label htmlFor="publish-opens">{t('publishOpens')}</Label>
          <Input
            id="publish-opens"
            type="datetime-local"
            value={opens}
            disabled={pending}
            onChange={(e) => setOpens(e.target.value)}
          />
        </div>

        <div>
          <Label htmlFor="publish-closes">{t('publishCloses')}</Label>
          <Input
            id="publish-closes"
            type="datetime-local"
            value={closes}
            required
            disabled={pending}
            onChange={(e) => setCloses(e.target.value)}
          />
        </div>

        <div className="sm:col-span-2">
          <Label htmlFor="publish-instructions">{t('publishInstructions')}</Label>
          <Textarea
            id="publish-instructions"
            rows={3}
            maxLength={2000}
            value={instructions}
            disabled={pending}
            placeholder={t('publishInstructionsHint')}
            onChange={(e) => setInstructions(e.target.value)}
          />
        </div>
      </div>

      {/*
        ┌───────────────────────────────────────────────────────────────────────┐
        │ NEITHER OPTION CAN MEAN "AS SOON AS THEY PRESS SUBMIT".               │
        │                                                                       │
        │ Every paper is 80/20, so every paper has short answers and every      │
        │ submission waits for a human to mark them. The wording says "once     │
        │ marking is done" rather than "immediately" for that reason — the      │
        │ honest promise, not the flattering one.                               │
        └───────────────────────────────────────────────────────────────────────┘
      */}
      <fieldset className="rounded-lg border p-4">
        <legend className="px-1 text-label-caps text-muted-foreground">
          {t('publishResults')}
        </legend>

        <div className="space-y-2">
          <ReleaseOption
            id="release-immediate"
            checked={release === 'immediate'}
            disabled={pending}
            onSelect={() => setRelease('immediate')}
            label={t('publishResultsImmediate')}
            hint={t('publishResultsImmediateHint')}
          />
          <ReleaseOption
            id="release-on-close"
            checked={release === 'on_close'}
            disabled={pending}
            onSelect={() => setRelease('on_close')}
            label={t('publishResultsOnClose')}
            hint={t('publishResultsOnCloseHint')}
          />
        </div>
      </fieldset>

      {/*
        ┌───────────────────────────────────────────────────────────────────────┐
        │ THE AUDIENCE IS LAST, AND IT IS THE STEP THAT MAKES THE EXAM REAL.    │
        │                                                                       │
        │ Everything above configures the sitting; this decides whether anybody │
        │ can see it. It is placed immediately above the button so it is the    │
        │ last thing read before publishing, rather than something scrolled     │
        │ past on the way to it.                                                │
        │                                                                       │
        │ Absent for a caller who may publish but not assign — they finish on   │
        │ the paper page, which states that nobody has been chosen.             │
        └───────────────────────────────────────────────────────────────────────┘
      */}
      {directory && (
        <fieldset className="rounded-lg border p-4">
          <legend className="px-1 text-label-caps text-muted-foreground">
            {t('publishAudience')}
          </legend>
          <AssignmentPicker
            rows={audience}
            onChange={setAudience}
            options={directory}
            disabled={pending}
          />
        </fieldset>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={pending} onClick={submit}>
          <MonitorPlayIcon />
          {pending ? t('publishing') : t('publish')}
        </Button>
      </div>

      {/* Only still true when nobody has been chosen in the step above. */}
      {audience.length === 0 && (
        <p className="text-body-sm text-muted-foreground">{t('publishHint')}</p>
      )}
    </div>
  )
}

/**
 * A radio and its explanation, as one clickable row.
 *
 * A bare radio with the hint as sibling text leaves the hint outside the label,
 * so a screen reader announces "Immediately" with no indication of what that
 * means — and the hint is the entire difference between the two options.
 */
function ReleaseOption({
  id,
  checked,
  disabled,
  onSelect,
  label,
  hint,
}: {
  id: string
  checked: boolean
  disabled: boolean
  onSelect: () => void
  label: string
  hint: string
}) {
  return (
    <label
      htmlFor={id}
      className={cn(
        'flex cursor-pointer items-start gap-3 rounded-md border p-3 transition-colors',
        checked ? 'border-primary bg-primary/5' : 'hover:bg-accent/40',
        disabled && 'cursor-not-allowed opacity-60',
      )}
    >
      <input
        id={id}
        type="radio"
        name="results-release"
        className="mt-1 size-4 shrink-0 accent-primary"
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
      />
      <span className="min-w-0">
        <span className="block text-body-md font-medium">{label}</span>
        <span className="block text-body-sm text-muted-foreground">{hint}</span>
      </span>
    </label>
  )
}
