import { notFound } from 'next/navigation'
import { getTranslations, getFormatter } from 'next-intl/server'
import { requirePermission } from '@/lib/auth/guards'
import { Link } from '@/lib/i18n/navigation'
import { getResultDetail, getAttemptReview, type AttemptReviewItem } from '@/server/actions/attempts'
import { buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { AlertTriangleIcon, ArrowLeftIcon, CheckCircle2Icon, XCircleIcon } from 'lucide-react'
import { isCheating } from '@/lib/attempts/closure'

/**
 * One published result.
 *
 * getResultDetail returns null for both "not yours" and "not released yet",
 * because my_result_detail() raises for either and the two must stay
 * indistinguishable. A 404 is the honest answer to both — telling somebody
 * their result exists but is being held is exactly the leak the release gate
 * is there to prevent.
 */
export default async function ResultDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  await requirePermission('attempts.read_own')
  const { id } = await params
  const t = await getTranslations('results')
  const format = await getFormatter()

  const detail = await getResultDetail(id)
  if (!detail) notFound()

  const breakdown = await getAttemptReview(id)

  const minutes =
    detail.submitted_at && detail.started_at
      ? Math.max(
          1,
          Math.round(
            (new Date(detail.submitted_at).getTime() - new Date(detail.started_at).getTime()) /
              60000,
          ),
        )
      : null

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <Link
          href="/results"
          className={buttonVariants({ variant: 'ghost', size: 'sm' }) + ' -ml-2 mb-2'}
        >
          <ArrowLeftIcon className="size-4" />
          {t('back')}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">{detail.exam_title}</h1>
      </div>

      <Card>
        <CardContent className="space-y-4 pt-6">
          {/* The closure is part of the record: a result earned by leaving the
              exam says so on the result, permanently. */}
          {isCheating(detail.submit_reason) && (
            <p className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertTriangleIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
              {t('cheatedNotice')}
            </p>
          )}
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="text-4xl font-semibold tabular-nums">
                {detail.percent ?? 0}
                <span className="text-xl text-muted-foreground">%</span>
              </p>
              <p className="text-sm text-muted-foreground">
                {t('scoreOf', { score: detail.score ?? 0, max: detail.max_score ?? 0 })}
                {' · '}
                {t('passMark', { percent: detail.pass_mark_percent })}
              </p>
            </div>

            <Badge
              variant={detail.passed ? 'default' : 'outline'}
              className="gap-1.5 px-3 py-1 text-sm"
            >
              {detail.passed ? (
                <CheckCircle2Icon className="size-4" />
              ) : (
                <XCircleIcon className="size-4" />
              )}
              {detail.passed ? t('passed') : t('failed')}
            </Badge>
          </div>

          <dl className="grid gap-1 border-t pt-4 text-sm text-muted-foreground sm:grid-cols-2">
            {detail.submitted_at && (
              <div>
                {t('taken', {
                  date: format.dateTime(new Date(detail.submitted_at), {
                    dateStyle: 'medium',
                    timeStyle: 'short',
                  }),
                })}
              </div>
            )}
            {minutes != null && <div>{t('timeTaken', { minutes })}</div>}
            {detail.published_at && (
              <div>
                {t('released', {
                  date: format.dateTime(new Date(detail.published_at), { dateStyle: 'medium' }),
                })}
              </div>
            )}
            {/* Who marked and who signed off — the accountability that makes a
                disputed mark answerable. Never what they wrote about it. */}
            {detail.evaluator_name && <div>{t('markedBy', { name: detail.evaluator_name })}</div>}
            {detail.verifier_names.length > 0 && (
              <div>{t('verifiedBy', { names: detail.verifier_names.join(', ') })}</div>
            )}
          </dl>
        </CardContent>
      </Card>

      <section className="space-y-3">
        <h2 className="text-sm font-medium text-muted-foreground">{t('breakdown')}</h2>
        {breakdown.map((item) => (
          <QuestionCard key={item.question_id} item={item} t={t} />
        ))}
      </section>
    </div>
  )
}

function QuestionCard({
  item,
  t,
}: {
  item: AttemptReviewItem
  t: Awaited<ReturnType<typeof getTranslations<'results'>>>
}) {
  const score = Number(item.score ?? 0)
  const marks = Number(item.marks)
  const verdict = score >= marks ? 'correct' : score > 0 ? 'partial' : 'incorrect'

  return (
    <Card>
      <CardHeader className="gap-2">
        <div className="flex items-start justify-between gap-3">
          <CardTitle className="text-base leading-relaxed">
            {t('question', { position: item.paper_position + 1 })} — {item.stem}
          </CardTitle>
          <Badge
            variant={verdict === 'correct' ? 'default' : verdict === 'partial' ? 'secondary' : 'outline'}
            className="shrink-0"
          >
            {t('awarded', { score, marks })}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-3">
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">{t('yourAnswer')}</p>
          <div className="rounded-md border bg-muted/30 p-3 text-sm whitespace-pre-wrap">
            {renderAnswer(item) || <span className="text-muted-foreground">{t('noAnswer')}</span>}
          </div>
        </div>

        {/* Per-part detail, from grade_detail. It reports what was submitted and
            whether each part was right — 0027 kept the expected value out of
            it, which is what makes it safe to show here. */}
        {Array.isArray((item.grade_detail as { blanks?: unknown[] })?.blanks) && (
          <ul className="space-y-1 text-sm">
            {((item.grade_detail as { blanks: Array<{ id: string; submitted: string; correct: boolean }> })
              .blanks
            ).map((b) => (
              <li key={b.id} className="flex items-center justify-between gap-3 border-b py-1 last:border-0">
                <span className="text-muted-foreground">{b.id}</span>
                <span className="flex-1 truncate">{b.submitted || '—'}</span>
                <span className={b.correct ? 'text-muted-foreground' : 'text-destructive'}>
                  {b.correct ? t('blankCorrect') : t('blankWrong')}
                </span>
              </li>
            ))}
          </ul>
        )}

        {item.grader_note && (
          <div>
            <p className="mb-1 text-xs font-medium text-muted-foreground">{t('note')}</p>
            <p className="text-sm">{item.grader_note}</p>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

/** The candidate's answer, in whatever shape its format uses. */
function renderAnswer(item: AttemptReviewItem): string {
  const answer = item.answer as Record<string, unknown> | null
  if (!answer) return ''

  if (typeof answer.text === 'string') return answer.text
  if (Array.isArray(answer.choices)) return answer.choices.join(', ')
  if (typeof answer.choice === 'string') return answer.choice
  if (typeof answer.value === 'boolean') return String(answer.value)
  if (Array.isArray(answer.order)) return answer.order.join(' → ')
  if (answer.values && typeof answer.values === 'object') {
    return Object.entries(answer.values as Record<string, string>)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n')
  }
  return ''
}
