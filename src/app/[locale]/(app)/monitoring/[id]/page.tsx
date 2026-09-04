import { notFound } from 'next/navigation'
import { getTranslations, getFormatter } from 'next-intl/server'
import { requireAnyPermission } from '@/lib/auth/guards'
import { Link } from '@/lib/i18n/navigation'
import {
  getMonitorAttemptHeader,
  getMonitorAttemptReview,
  type MonitorReviewItem,
} from '@/server/actions/monitoring'
import { Badge } from '@/components/ui/badge'
import { buttonVariants } from '@/components/ui/button'
import { AlertTriangleIcon, ArrowLeftIcon, CheckCircle2Icon, XCircleIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { isAutoSubmitted, isCheating } from '@/lib/attempts/closure'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The complete paper, as one person sat it.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ EVERYTHING ON THIS PAGE IS THE ATTEMPT'S OWN RECORD. Questions come from  ║
 * ║ attempt_questions.snapshot — the paper as SERVED, not the bank as it is   ║
 * ║ today — and every verdict is the one grade_detail already holds. Nothing  ║
 * ║ regrades, nothing rebuilds; if the bank changed since the exam, this      ║
 * ║ page shows the exam.                                                     ║
 * ║                                                                          ║
 * ║ WHO SEES WHAT is 0093's decision, not this page's: reach needs           ║
 * ║ attempts.read_team/read_all (team = same outlet), and correct answers    ║
 * ║ arrive ONLY for callers holding evaluation.evaluate. When they are       ║
 * ║ absent from the data, the page simply has no key column to draw.         ║
 * ║                                                                          ║
 * ║ This is THE paper viewer: the participant table, the user history table  ║
 * ║ and the score chart all land here. One viewer, however you arrive.       ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */

type Verdict = 'correct' | 'wrong' | 'unanswered' | 'review'

function verdictOf(q: MonitorReviewItem): Verdict {
  if (!q.answered) return 'unanswered'
  if (q.needs_review) return 'review'
  if (q.correct === true) return 'correct'
  if (q.correct === false) return 'wrong'
  return 'review'
}

const GLYPH: Record<Verdict, string> = {
  correct: '✓',
  wrong: '✗',
  unanswered: '—',
  review: '⚠',
}

const CHIP_TONE: Record<Verdict, string> = {
  correct: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400',
  wrong: 'border-destructive/40 text-destructive',
  unanswered: 'border-muted-foreground/30 text-muted-foreground',
  review: 'border-amber-500/40 text-amber-700 dark:text-amber-500',
}

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

  const auto = isAutoSubmitted(header.submit_reason)
  const cheated = isCheating(header.submit_reason)

  // Counted from the recorded verdicts, the same source every card shows.
  const verdicts = review.map(verdictOf)
  const counts = {
    correct: verdicts.filter((v) => v === 'correct').length,
    wrong: verdicts.filter((v) => v === 'wrong').length,
    unanswered: verdicts.filter((v) => v === 'unanswered').length,
    review: verdicts.filter((v) => v === 'review').length,
  }

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
          <Link href={`/users/${header.candidate_id}`} className="hover:underline">
            {header.candidate_name || header.candidate_email}
          </Link>
        </h1>
        <p className="text-sm text-muted-foreground">
          {[header.department, header.outlet].filter(Boolean).join(' · ')}
          {' · '}
          {header.candidate_email}
        </p>
      </div>

      {/* ── The outcome, and the paper's shape ──────────────────────────── */}
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
              {/* A cheating closure is named as such; only the clock and the
                  sweeper keep the neutral mechanism note. */}
              {cheated ? (
                // The machine reason rides along for the reviewer:
                // tab_switch = the page went hidden, focus_loss = a window
                // covered it. §closure.ts is the vocabulary.
                <span className="text-destructive">
                  {' · '}
                  {t('cheatingNote')} ({header.submit_reason})
                </span>
              ) : (
                auto &&
                header.submit_reason && (
                  <> · {t('autoSubmittedNote', { reason: header.submit_reason })}</>
                )
              )}
            </p>
          </div>

          <span className="flex flex-wrap items-center gap-1.5">
          {cheated && (
            <Badge variant="destructive" className="gap-1.5 px-3 py-1 text-sm">
              <AlertTriangleIcon className="size-4" />
              {te('monCheating')}
            </Badge>
          )}
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
          </span>
        </div>

        <dl className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
          <Fig label={t('paperQuestions')} value={String(header.question_n)} />
          <Fig label={t('paperAnswered')} value={String(header.answered_n)} />
          <Fig label={t('paperUnanswered')} value={String(counts.unanswered)} />
          <Fig label={t('paperCorrect')} value={String(counts.correct)} />
          <Fig label={t('paperWrong')} value={String(counts.wrong)} />
          <Fig label={t('needsReview')} value={String(counts.review)} />
          <Fig label={te('monStarted')} value={when(header.started_at)} />
          <Fig label={te('monSubmittedCol')} value={when(header.submitted_at)} />
        </dl>
      </section>

      {/* ── Question navigator ───────────────────────────────────────────
          Anchors, not JavaScript: #q-N plus scroll-margin on the targets is
          the whole mechanism, so it works before hydration and on every
          assistive technology. Sticky under the app header; horizontally
          scrollable where twenty chips outgrow a phone. */}
      <nav
        aria-label={t('navigatorLabel')}
        className="glass sticky top-16 z-20 -mx-4 overflow-x-auto border-y px-4 py-2 lg:mx-0 lg:rounded-xl lg:border"
      >
        <ol className="flex w-max gap-1.5 lg:flex-wrap">
          {review.map((q, i) => (
            <li key={q.question_id}>
              <a
                href={`#q-${q.paper_position}`}
                className={cn(
                  'grid min-h-11 min-w-11 place-items-center rounded-md border text-sm tabular-nums',
                  CHIP_TONE[verdicts[i]],
                )}
                aria-label={`${q.paper_position}: ${
                  verdicts[i] === 'correct' ? te('resultPass')
                  : verdicts[i] === 'wrong' ? te('resultFail')
                  : verdicts[i] === 'review' ? t('needsReview')
                  : t('notAnswered')
                }`}
              >
                {q.paper_position}
                <span aria-hidden className="ml-0.5">{GLYPH[verdicts[i]]}</span>
              </a>
            </li>
          ))}
        </ol>
      </nav>

      {/* ── Every question, as served ────────────────────────────────────── */}
      <section className="space-y-4">
        {review.map((q, i) => (
          <QuestionCard
            key={q.question_id}
            q={q}
            verdict={verdicts[i]}
            labels={{
              pass: te('resultPass'),
              fail: te('resultFail'),
              notAnswered: t('notAnswered'),
              needsReview: t('needsReview'),
              givenAnswer: t('givenAnswer'),
              answerKey: t('answerKey'),
              selectedMark: t('selectedMark'),
              correctMark: t('correctMark'),
            }}
          />
        ))}
      </section>
    </div>
  )
}

function Fig({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-label-caps text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 tabular-nums">{value}</dd>
    </div>
  )
}

function QuestionCard({
  q,
  verdict,
  labels,
}: {
  q: MonitorReviewItem
  verdict: Verdict
  labels: Record<
    'pass' | 'fail' | 'notAnswered' | 'needsReview' | 'givenAnswer' | 'answerKey' | 'selectedMark' | 'correctMark',
    string
  >
}) {
  const choices = q.content?.choices ?? []
  const isChoice = q.qformat.startsWith('choice') && choices.length > 0

  return (
    // scroll-mt clears the sticky navigator when an anchor chip jumps here.
    <article id={`q-${q.paper_position}`} className="scroll-mt-32 rounded-xl border bg-card p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 font-medium">
          <span className="mr-2 text-muted-foreground tabular-nums">{q.paper_position}.</span>
          {q.stem}
        </p>
        <span className="shrink-0 text-sm tabular-nums text-muted-foreground">
          {q.score ?? 0} / {q.marks}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
        {verdict === 'unanswered' && (
          <Badge variant="outline" className={CHIP_TONE.unanswered}>— {labels.notAnswered}</Badge>
        )}
        {verdict === 'correct' && (
          <Badge variant="outline" className={CHIP_TONE.correct}>✓ {labels.pass}</Badge>
        )}
        {verdict === 'wrong' && (
          <Badge variant="outline" className={CHIP_TONE.wrong}>✗ {labels.fail}</Badge>
        )}
        {(verdict === 'review' || q.needs_review) && (
          <Badge variant="outline" className={CHIP_TONE.review}>⚠ {labels.needsReview}</Badge>
        )}
        <span className="text-label-caps text-muted-foreground">{q.qformat}</span>
      </div>

      {isChoice ? (
        /*
         * Every option, exactly as served. The candidate's pick and the key
         * each carry a TEXT marker beside the highlight — colour alone would
         * fail the person who cannot see the difference, and the key marker
         * only exists when 0093 sent a key at all.
         */
        <ul className="mt-3 space-y-1.5">
          {choices.map((c) => {
            const picked = q.selected === c.id
            const isKey = q.correct_answer !== null && q.correct_answer === c.id
            return (
              <li
                key={c.id}
                className={cn(
                  'flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-sm',
                  isKey && 'border-emerald-500/50 bg-emerald-500/5',
                  picked && !isKey && 'border-destructive/50 bg-destructive/5',
                  !picked && !isKey && 'border-transparent bg-muted/40',
                )}
              >
                <span className="font-medium uppercase tabular-nums">{c.id}.</span>
                <span className="min-w-0 flex-1">{c.text}</span>
                {picked && (
                  <Badge variant="outline" className="shrink-0">
                    {labels.selectedMark}
                  </Badge>
                )}
                {isKey && (
                  <Badge variant="outline" className={cn('shrink-0', CHIP_TONE.correct)}>
                    {labels.correctMark}
                  </Badge>
                )}
              </li>
            )
          })}
        </ul>
      ) : (
        <div className="mt-3 space-y-2 text-sm">
          {q.answered && (
            <p className="text-muted-foreground">
              {labels.givenAnswer}:{' '}
              <span className="text-foreground">&ldquo;{q.answer_text ?? '—'}&rdquo;</span>
            </p>
          )}
          {q.correct_answer && (
            <p className="text-muted-foreground">
              {labels.answerKey}:{' '}
              <span className="text-foreground">&ldquo;{q.correct_answer}&rdquo;</span>
            </p>
          )}
        </div>
      )}
    </article>
  )
}
