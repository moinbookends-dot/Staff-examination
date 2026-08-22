'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { verifyAttempt, publishAttempt } from '@/server/actions/evaluation'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
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
 * Approve, send back, or release.
 *
 * The approve button is hidden from the person who marked the paper, but that
 * is presentation only — verify_attempt() refuses them by name, and the test
 * suite asserts the refusal rather than the hidden button. Hiding it just means
 * nobody has to discover the rule by being told off by an error message.
 */
export function DecisionButtons({
  attemptId,
  evaluatedByMe,
}: {
  attemptId: string
  evaluatedByMe: boolean
}) {
  const t = useTranslations('evaluation')
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  function decide(decision: 'verified' | 'returned') {
    setError(null)
    startTransition(async () => {
      const result = await verifyAttempt({ attemptId, decision, note: reason || undefined })
      if (result.ok) {
        setConfirmOpen(false)
        setReason('')
        router.refresh()
      } else {
        setError(result.error)
      }
    })
  }

  if (evaluatedByMe) {
    return <p className="text-xs text-muted-foreground">{t('yourOwnWork')}</p>
  }

  return (
    <>
      <div className="flex flex-col items-end gap-1">
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setConfirmOpen(true)} disabled={pending}>
            {t('sendBack')}
          </Button>
          <Button onClick={() => decide('verified')} disabled={pending}>
            {t('approve')}
          </Button>
        </div>
        {error && <p className="text-xs text-destructive">{error}</p>}
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('confirmReturnTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('confirmReturnBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <Textarea
            rows={3}
            placeholder={t('reasonPlaceholder')}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <AlertDialogFooter>
            <AlertDialogCancel>{t('cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => decide('returned')}>
              {t('confirmReturn')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** For auto-graded papers held back because the exam wanted a sign-off. */
export function ReleaseButton({ attemptId }: { attemptId: string }) {
  const t = useTranslations('evaluation')
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            const result = await publishAttempt(attemptId)
            if (result.ok) router.refresh()
            else setError(result.error)
          })
        }
      >
        {t('release')}
      </Button>
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  )
}
