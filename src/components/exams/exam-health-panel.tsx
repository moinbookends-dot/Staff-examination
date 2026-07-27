'use client'

import { useState, useTransition } from 'react'
import { useRouter } from '@/lib/i18n/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import {
  sortIssues,
  blockingIssues,
  canPublish,
  remedyFor,
  type HealthIssue,
} from '@/lib/exams/health'
import { getExamHealth, publishExam, setExamStatus } from '@/server/actions/exams'
import type { ExamStatus } from '@/lib/exams/rules'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
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
import { AlertTriangleIcon, CheckCircle2Icon, RefreshCwIcon, XCircleIcon } from 'lucide-react'

/**
 * Exam Health, and the publish gate it guards.
 *
 * Every row here comes from public.exam_health(), which runs the REAL DRAW —
 * two rules can match the same question, and deduping makes the second fall
 * short in a way per-rule counting cannot see. publish_exam() calls the same
 * function, so this panel and the gate that refuses cannot disagree.
 *
 * Nothing is re-derived on the client. Severity, message and detail are the
 * database's answer; this file decides only how to draw them, and pairs each
 * code with a remedy so a blocking issue tells a chef what to do rather than
 * only what is wrong.
 */
export function ExamHealthPanel({
  examId,
  status,
  initialIssues,
  canPublishExam,
}: {
  examId: string
  status: ExamStatus
  initialIssues: HealthIssue[]
  canPublishExam: boolean
}) {
  const router = useRouter()
  const t = useTranslations('exams.health')
  const [pending, startTransition] = useTransition()
  const [issues, setIssues] = useState(initialIssues)
  const [error, setError] = useState<string | null>(null)
  const [confirmPublish, setConfirmPublish] = useState(false)

  const blockers = blockingIssues(issues)
  const advisories = issues.filter((i) => i.severity === 'advisory')
  const ready = canPublish(issues)
  const isDraft = status === 'draft'

  function recheck() {
    setError(null)
    startTransition(async () => {
      setIssues(await getExamHealth(examId))
    })
  }

  function publish() {
    setError(null)
    startTransition(async () => {
      const result = await publishExam(examId)
      if (!result.ok) {
        // publish_exam raises with its blocking rows attached, so a refusal
        // lands back here as the same list the panel already renders rather
        // than as an opaque failure.
        if (result.issues?.length) setIssues(result.issues)
        setError(result.error ?? 'Could not publish.')
        return
      }
      toast.success(t('published'))
      router.refresh()
    })
  }

  function moveTo(next: 'active' | 'completed' | 'archived' | 'cancelled') {
    setError(null)
    startTransition(async () => {
      const result = await setExamStatus({ id: examId, status: next })
      if (!result.ok) {
        setError(result.error ?? 'Could not change the status.')
        return
      }
      router.refresh()
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {isDraft &&
            (ready ? (
              <CheckCircle2Icon className="size-4 text-primary" />
            ) : (
              <XCircleIcon className="size-4 text-destructive" />
            ))}
          {t('title')}
        </CardTitle>
        <CardDescription>
          {isDraft ? (ready ? t('readyToPublish') : t('notReady')) : t('publishedDescription')}
        </CardDescription>
      </CardHeader>

      <CardContent className="space-y-4">
        {error && (
          <p className="rounded-md border border-destructive p-3 text-sm text-destructive">
            {error}
          </p>
        )}

        {issues.length === 0 && (
          <p className="text-sm text-muted-foreground">{t('noIssues')}</p>
        )}

        {blockers.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium text-destructive">
              {t('blockingCount', { count: blockers.length })}
            </p>
            <IssueList issues={blockers} tone="blocking" />
          </div>
        )}

        {advisories.length > 0 && (
          <div className="space-y-2">
            <p className="text-sm font-medium">{t('advisoryCount', { count: advisories.length })}</p>
            {/* Stated explicitly, because a warning that looks like an error
                gets treated like one and a chef stops publishing good exams. */}
            <p className="text-sm text-muted-foreground">{t('advisoryHint')}</p>
            <IssueList issues={advisories} tone="advisory" />
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={recheck} disabled={pending}>
            <RefreshCwIcon />
            {t('recheck')}
          </Button>

          {isDraft && canPublishExam && (
            <Button
              size="sm"
              onClick={() => setConfirmPublish(true)}
              // Disabled with the reasons listed above rather than behind a
              // failed submit. A button that is enabled and then refuses
              // teaches people to click it twice.
              disabled={pending || !ready}
              title={ready ? undefined : t('fixBlockersFirst')}
            >
              {t('publish')}
            </Button>
          )}

          {status === 'scheduled' && canPublishExam && (
            <>
              <Button size="sm" onClick={() => moveTo('active')} disabled={pending}>
                {t('openNow')}
              </Button>
              <Button variant="outline" size="sm" onClick={() => moveTo('cancelled')} disabled={pending}>
                {t('cancel')}
              </Button>
            </>
          )}

          {status === 'active' && canPublishExam && (
            <Button variant="outline" size="sm" onClick={() => moveTo('completed')} disabled={pending}>
              {t('close')}
            </Button>
          )}

          {(status === 'completed' || status === 'cancelled') && canPublishExam && (
            <Button variant="outline" size="sm" onClick={() => moveTo('archived')} disabled={pending}>
              {t('archive')}
            </Button>
          )}
        </div>
      </CardContent>

      {/* Publishing freezes the paper and notifies the audience. Both are hard
          to walk back — the exam becomes immutable and 300 people get an
          email — so it asks first. */}
      <AlertDialog open={confirmPublish} onOpenChange={setConfirmPublish}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('confirmTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('confirmBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('confirmCancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmPublish(false)
                publish()
              }}
            >
              {t('confirmPublish')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}

function IssueList({ issues, tone }: { issues: HealthIssue[]; tone: 'blocking' | 'advisory' }) {
  return (
    <ul className="space-y-2">
      {sortIssues(issues).map((issue, index) => (
        <li
          key={`${issue.code}-${issue.rule_id ?? index}`}
          className={`rounded-md border p-3 text-sm ${
            tone === 'blocking' ? 'border-destructive/40' : ''
          }`}
        >
          <div className="flex items-start gap-2">
            {tone === 'blocking' ? (
              <XCircleIcon className="mt-0.5 size-4 shrink-0 text-destructive" />
            ) : (
              <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            )}
            <div className="space-y-1">
              <p>{issue.message}</p>
              {/* The database says what is wrong; the remedy says what to do.
                  Kept apart so a SQL message can stay short and factual. */}
              {remedyFor(issue.code) && (
                <p className="text-muted-foreground">{remedyFor(issue.code)}</p>
              )}
            </div>
          </div>
        </li>
      ))}
    </ul>
  )
}
