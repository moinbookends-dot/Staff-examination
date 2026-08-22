import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { requirePermission } from '@/lib/auth/guards'
import { Link } from '@/lib/i18n/navigation'
import { getAttemptPaper, getAttemptState, getAttemptResult } from '@/server/actions/attempts'
import { AttemptRunner } from '@/components/attempts/attempt-runner'
import { buttonVariants } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { CheckCircle2Icon, ClockIcon } from 'lucide-react'

/**
 * Sitting one attempt.
 *
 * The route is /attempt/[id] rather than /exams/[id]/take on purpose: what a
 * candidate is working through is the ATTEMPT, not the exam. Two attempts at the
 * same exam are different papers when paper_mode is per_attempt, and a URL that
 * named only the exam could not tell them apart.
 *
 * There is no separate results route either. Once the attempt is closed this
 * same page shows the outcome, because the alternative is a redirect that races
 * the submit and a back button that lands on a paper no longer accepting
 * answers.
 */
export default async function AttemptPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  await requirePermission('attempts.take')
  const { id } = await params
  const t = await getTranslations('sitting')

  const attempt = await getAttemptState(id)
  // getAttemptState returns null for both "no such attempt" and "not yours" —
  // attempts_read_own makes the two indistinguishable, and they must stay that
  // way. A 404 is the honest response to both.
  if (!attempt) notFound()

  if (attempt.status !== 'in_progress') {
    const result = await getAttemptResult(id)

    // `published` is the ONLY thing that opens this up, and it is the database's
    // answer, not a status this page interprets. my_attempts() returns score,
    // max_score and passed as null for anything unreleased, so even if this
    // branch were wrong there would be nothing here to show.
    const released = result?.published === true

    return (
      <div className="mx-auto max-w-xl space-y-6">
        <Card>
          <CardHeader className="items-center gap-2 text-center">
            {released ? (
              <CheckCircle2Icon className="size-8 text-muted-foreground" />
            ) : (
              <ClockIcon className="size-8 text-muted-foreground" />
            )}
            <CardTitle>{t('resultTitle')}</CardTitle>
            <CardDescription>{attempt.exam_title}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4 text-center">
            {released ? (
              <>
                <p className="text-3xl font-semibold tabular-nums">
                  {result?.score ?? 0}
                  <span className="text-lg text-muted-foreground">
                    {' / '}
                    {result?.max_score ?? 0}
                  </span>
                </p>
                <p className="text-sm text-muted-foreground">
                  {result?.passed ? t('passed') : t('failed')}
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{t('resultPending')}</p>
            )}

            <Link href="/my-exams" className={buttonVariants({ variant: 'outline' })}>
              {t('backToExams')}
            </Link>
          </CardContent>
        </Card>
      </div>
    )
  }

  const questions = await getAttemptPaper(id)

  return (
    <div className="mx-auto max-w-2xl">
      <AttemptRunner attempt={attempt} questions={questions} />
    </div>
  )
}
