'use client'

import { useState, useTransition } from 'react'
import { useRouter } from '@/lib/i18n/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { MonitorPlayIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { InlineError } from '@/components/ui/inline-error'
import type { PublishPaperResult } from '@/server/actions/papers'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Put a generated paper on screens.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ PUBLISHING DOES NOT ASSIGN ANYBODY, AND THE FORM SAYS SO OUT LOUD.        ║
 * ║                                                                           ║
 * ║ On success this navigates to the exam, where the audience is chosen. That ║
 * ║ is one extra step, and it is deliberate: the assignment picker already    ║
 * ║ exists there, and an exam with no audience is invisible rather than       ║
 * ║ visible to everyone. The hint under the button exists so nobody publishes ║
 * ║ and walks away believing the exam is running.                            ║
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
  /** Present only for a caller holding both exams.create and exams.publish. */
  onPublish?: (input: {
    paperId: string
    title: string
    durationMinutes: number
    maxAttempts: number
    passMarkPercent: number
    opensAt: string | null
    closesAt: string | null
  }) => Promise<PublishPaperResult>
}

export function PublishPaper({ paperId, paperNo, marks, retired, onPublish }: PublishPaperProps) {
  const t = useTranslations('papers')
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const [title, setTitle] = useState(t('publishDefaultTitle', { no: paperNo }))
  // Generous but not unbounded: a 20-mark paper in 30 minutes is the house
  // default, and 50 marks gets proportionally longer.
  const [duration, setDuration] = useState(marks >= 50 ? 60 : 30)
  const [attempts, setAttempts] = useState(1)
  const [passMark, setPassMark] = useState(60)
  const [opens, setOpens] = useState('')
  const [closes, setCloses] = useState('')

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

    if (!title.trim()) {
      setError(t('publishNeedsTitle'))
      return
    }

    startTransition(async () => {
      const result = await onPublish({
        paperId,
        title: title.trim(),
        durationMinutes: duration,
        maxAttempts: attempts,
        passMarkPercent: passMark,
        opensAt: toIso(opens),
        closesAt: toIso(closes),
      })

      if (!result.ok) {
        setError(result.message)
        return
      }

      toast.success(t('publishDone', { no: result.paperNo }))
      // Straight to the audience picker — the step this form deliberately
      // does not duplicate.
      router.push(`/exams/${result.examId}`)
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

        <div className="sm:col-span-2">
          <Label htmlFor="publish-closes">{t('publishCloses')}</Label>
          <Input
            id="publish-closes"
            type="datetime-local"
            value={closes}
            disabled={pending}
            onChange={(e) => setCloses(e.target.value)}
          />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Button disabled={pending} onClick={submit}>
          <MonitorPlayIcon />
          {pending ? t('publishing') : t('publish')}
        </Button>
      </div>

      <p className="text-body-sm text-muted-foreground">{t('publishHint')}</p>
    </div>
  )
}
