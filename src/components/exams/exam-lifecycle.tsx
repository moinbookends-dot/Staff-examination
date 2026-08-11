'use client'

import { useState, useTransition } from 'react'
import { useRouter } from '@/lib/i18n/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { CircleStopIcon, XCircleIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import type { ExamState } from '@/lib/exams/state'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Stopping an exam early, or calling it off.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ A PUBLISHED PAPER HAD NO WAY TO BE CANCELLED OR CLOSED. AT ALL.           ║
 * ║                                                                           ║
 * ║ `setExamStatus` is the only writer of the exam lifecycle, and it was      ║
 * ║ mounted exclusively inside ExamHealthPanel — a legacy component that      ║
 * ║ /exams/[id] deliberately hid for paper-backed exams. So the control       ║
 * ║ existed, the permission existed, and the one kind of exam this product    ║
 * ║ actually produces could not reach either.                                 ║
 * ║                                                                           ║
 * ║ In practice that meant a paper published with the wrong deadline, or to   ║
 * ║ the wrong outlet, could only be waited out.                               ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ TWO ACTIONS, AND THEY ARE NOT THE SAME THING.                            │
 * │                                                                           │
 * │ CLOSE NOW ends a sitting that was legitimate — the paper counts, results  │
 * │ come out, people who finished keep their marks.                           │
 * │ CANCEL calls it off — the sitting should not have happened.               │
 * │                                                                           │
 * │ Cancel therefore asks for confirmation and Close does not. Neither        │
 * │ touches an attempt already in flight: `expires_at` was fixed when each    │
 * │ candidate started, so nobody is cut off mid-question by an administrative │
 * │ decision they had no part in.                                             │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */

export type ExamStatusChange = (input: {
  id: string
  status: 'completed' | 'cancelled'
}) => Promise<{ ok: boolean; error?: string }>

export function ExamLifecycle({
  examId,
  state,
  onChange,
}: {
  examId: string
  state: ExamState
  onChange: ExamStatusChange
}) {
  const t = useTranslations('exams')
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)

  const move = (status: 'completed' | 'cancelled') => {
    setError(null)
    startTransition(async () => {
      const result = await onChange({ id: examId, status })
      if (!result.ok) {
        setError(result.error ?? t('lifecycleFailed'))
        return
      }
      toast.success(status === 'completed' ? t('lifecycleClosed') : t('lifecycleCancelled'))
      setConfirming(false)
      router.refresh()
    })
  }

  return (
    <div className="space-y-3">
      {error && <InlineError>{error}</InlineError>}

      <div className="flex flex-wrap items-center gap-2">
        {/* Only an exam that is actually open can be closed early. A scheduled
            one has not started, so "close now" would be a confusing way to
            say "cancel". */}
        {state === 'live' && (
          <Button variant="outline" size="sm" disabled={pending} onClick={() => move('completed')}>
            <CircleStopIcon />
            {t('lifecycleCloseNow')}
          </Button>
        )}

        {confirming ? (
          <>
            <span className="text-body-sm text-muted-foreground">{t('lifecycleConfirm')}</span>
            <Button
              variant="destructive"
              size="sm"
              disabled={pending}
              onClick={() => move('cancelled')}
            >
              {t('lifecycleConfirmYes')}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() => setConfirming(false)}
            >
              {t('lifecycleConfirmNo')}
            </Button>
          </>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            disabled={pending}
            onClick={() => setConfirming(true)}
            className="text-destructive hover:text-destructive"
          >
            <XCircleIcon />
            {t('lifecycleCancel')}
          </Button>
        )}
      </div>

      <p className="text-body-sm text-muted-foreground">{t('lifecycleHint')}</p>
    </div>
  )
}
