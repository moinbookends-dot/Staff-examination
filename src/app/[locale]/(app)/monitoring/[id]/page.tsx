import { notFound } from 'next/navigation'
import { getTranslations, getFormatter } from 'next-intl/server'
import { requireAnyPermission } from '@/lib/auth/guards'
import { Link } from '@/lib/i18n/navigation'
import {
  getMonitorAttemptHeader,
  getMonitorAttemptReview,
} from '@/server/actions/monitoring'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { ArrowLeftIcon, CheckCircle2Icon, XCircleIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * One attempt, seen by a monitor.
 *
 * NOT the candidate's own result page (results/[id] — own-only and
 * release-gated) and NOT the marking form (evaluate/[id] — writes marks).
 * This is the read-only view a chef opens from the participant table.
 *
 * Reach is the DATABASE's decision: monitor_attempt_header/review (0092)
 * refuse anyone without attempts.read_team/read_all, refuse out-of-outlet
 * targets for team scope, and return the model answer only to callers who
 * hold evaluation.evaluate. A null here means refused-or-absent, and 404 is
 * the honest rendering of both.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export default async function MonitorAttemptPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  await requireAnyPermission(['attempts.read_team', 'attempts.read_all'])
  const { id } = await params
  const t = await getTranslations('perf')
  const te = await getTranslations('exams')
  const format = await getFormatter()

  const header = await getMonitorAttemptHeader(id)
  if (!header) notFound()
  const review = await getMonitorAttemptReview(id)

  const when = (iso: string | null) =>
    iso ? format.dateTime(new Date(iso), { dateStyle: 'medium', timeStyle: 'short' }) : '—'

  const percent =
    header.score !== null && header.max_score
      ? Math.round((Number(header.score) / Number(header.max_score)) * 100)
      : null

  const auto = ['timer', 'tab_switch', 'sweeper'].includes(header.submit_reason ?? '')

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href={`/exams/${header.exam_id}`}
          className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), '-ml-2 mb-2')}
        >
          <ArrowLeftIcon className="size-4" />
          {header.exam_title}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          <Link href={`/team/${header.candidate_id}`} className="hover:underline">
            {header.candidate_name || header.candidate_email}
          </Link>
        </h1>
        <p className="text-sm text-muted-foreground">
          {[header.department, header.outlet].filter(Boolean).join(' · ')}
          {' · '}
          {header.candidate_email}
        </p>
      </div>

      {/* ── The outcome ─────────────────────────────────────────────────── */}
      <section className="rounded-xl border bg-card p-5">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <p className="text-4xl font-semibold tabular-nums">
              {header.score !== null ? `${header.score} / ${header.max_score}` : '—'}
              {percent !== null && (
                <span className="ml-2 text-xl text-muted-foreground">{percent}%</span>
              )}
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('colAttempt')} {header.attempt_no ?? 1}
              {' · '}
              {te('monProgress')}: {header.answered_n}/{header.question_n}
              {auto && header.submit_reason && (
                <> · {t('autoSubmittedNote', { reason: header.submit_reason })}</>
              )}
            </p>
          </div>

          {header.passed !== null ? (
            <Badge
              variant="outline"
              className={cn(
                'gap-1.5 px-3 py-1 text-sm',
                header.passed
                  ? 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400'
                  : 'border-destructive/40 text-destructive',
              )}
            >
              {header.passed ? (
                <CheckCircle2Icon className="size-4" />
              ) : (
                <XCircleIcon className="size-4" />
              )}
              {header.passed ? te('resultPass') : te('resultFail')}
            </Badge>
          ) : (
            <Badge variant="outline">{te('resultPending')}</Badge>
          )}
        </div>

        <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-label-caps text-muted-foreground">{te('monStarted')}</dt>
            <dd className="mt-0.5 tabular-nums">{when(header.started_at)}</dd>
          </div>
          <div>
            <dt className="text-label-caps text-muted-foreground">{te('monSubmittedCol')}</dt>
            <dd className="mt-0.5 tabular-nums">{when(header.submitted_at)}</dd>
          </div>
          <div>
            <dt className="text-label-caps text-muted-foreground">{te('monStatus')}</dt>
            <dd className="mt-0.5">{header.status}</dd>
          </div>
        </dl>
      </section>

      {/* ── Question by question ─────────────────────────────────────────── */}
      <section className="space-y-3">
        {review.map((q) => (
          <div key={q.question_id} className="rounded-xl border bg-card p-4">
            <div className="flex items-start justify-between gap-3">
              <p className="min-w-0 text-sm font-medium">
                <span className="mr-2 text-muted-foreground tabular-nums">
                  {q.paper_position}.
                </span>
                {q.stem}
              </p>
              <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
                {q.score ?? 0} / {q.marks}
              </span>
            </div>

            <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
              {!q.answered ? (
                <Badge variant="outline" className="text-muted-foreground">
                  {t('notAnswered')}
                </Badge>
              ) : q.correct === true ? (
                <Badge
                  variant="outline"
                  className="border-emerald-500/40 text-emerald-700 dark:text-emerald-400"
                >
                  <CheckCircle2Icon className="size-3" /> {te('resultPass')}
                </Badge>
              ) : q.correct === false ? (
                <Badge variant="outline" className="border-destructive/40 text-destructive">
                  <XCircleIcon className="size-3" /> {te('resultFail')}
                </Badge>
              ) : null}
              {q.needs_review && (
                <Badge variant="outline" className="text-amber-700 dark:text-amber-500">
                  {t('needsReview')}
                </Badge>
              )}
            </div>

            {q.answered && q.answer && (
              <p className="mt-2 text-sm text-muted-foreground">
                {t('givenAnswer')}:{' '}
                <span className="text-foreground">
                  {String(
                    (q.answer as { text?: string }).text ??
                      (q.answer as { choice?: string }).choice ??
                      '—',
                  )}
                </span>
              </p>
            )}

            {/* Present only when 0092 decided this caller may hold the key. */}
            {q.model_answer && (
              <p className="mt-1 text-sm text-muted-foreground">
                {t('answerKey')}: <span className="text-foreground">{q.model_answer}</span>
              </p>
            )}
          </div>
        ))}
      </section>
    </div>
  )
}
