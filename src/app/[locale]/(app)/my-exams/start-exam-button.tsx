'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { startAttempt } from '@/server/actions/attempts'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
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

/**
 * Starts or resumes an attempt.
 *
 * Starting is confirmed, resuming is not. The confirmation is not ceremony: the
 * clock starts server-side the moment start_attempt returns, and it does not
 * stop for a closed tab or a second thought. Somebody tapping a card on a phone
 * between covers deserves to be told that before it costs them an attempt.
 *
 * Resuming has nothing to warn about — the attempt is already running.
 */
export function StartExamButton({
  examId,
  openAttemptId,
  disabled,
}: {
  examId: string
  openAttemptId: string | null
  disabled?: boolean
}) {
  const t = useTranslations('sitting')
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function go() {
    setError(null)
    startTransition(async () => {
      const result = await startAttempt(examId)
      if (result.ok) {
        router.push(`/attempt/${result.data.attemptId}`)
      } else {
        setError(result.error)
      }
    })
  }

  // Full width and size lg on both paths: this is the one action on the card,
  // and it is tapped with a thumb.
  if (openAttemptId) {
    return (
      <Button
        size="lg"
        className="w-full"
        onClick={() => router.push(`/attempt/${openAttemptId}`)}
        disabled={pending}
      >
        {t('resume')}
      </Button>
    )
  }

  return (
    <>
      <div className="space-y-2">
        <Button
          size="lg"
          className="w-full"
          onClick={() => setOpen(true)}
          disabled={disabled || pending}
        >
          {t('start')}
        </Button>
        {/* InlineError carries role="alert". startAttempt refuses for reasons
            the candidate can act on — the window has shut, no attempts left —
            and a paragraph that appears with no announcement is a refusal they
            may never learn about. */}
        {error && <InlineError className="text-xs">{error}</InlineError>}
      </div>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('confirmStartTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('confirmStartBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={go}>{t('confirmStart')}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
