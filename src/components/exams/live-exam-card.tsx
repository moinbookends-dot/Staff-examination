import { ClockIcon, ListChecksIcon, TargetIcon, TimerIcon, UsersIcon } from 'lucide-react'
import { Link } from '@/lib/i18n/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ExamStateBadge } from './exam-state-badge'
import type { LiveExamRow } from '@/server/exams/live'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * One exam, as an operator sees it.
 *
 * A card rather than a table row: the numbers that matter here are a ratio and
 * a deadline, and both read badly squeezed into columns on a phone — which is
 * where a chef checking on an exam mid-service actually is.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE PROGRESS BAR SHOWS ATTEMPTED, NOT SUBMITTED, AND THE TWO ARE STACKED. │
 * │                                                                           │
 * │ "23 / 40 attempted" is the number that decides whether to go and chase    │
 * │ people. Submitted is the number that decides whether marking can start.   │
 * │ Showing only one of them answers half the question, so both are here with │
 * │ submitted drawn inside attempted — the shape makes it obvious that every  │
 * │ submission is also an attempt.                                            │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */
export function LiveExamCard({
  exam,
  stateLabel,
  labels,
  formatDate,
}: {
  exam: LiveExamRow
  stateLabel: string
  labels: {
    paper: string
    questions: string
    marks: string
    duration: string
    starts: string
    deadline: string
    attempts: string
    submitted: string
    inProgress: string
    notStarted: string
    ofEmployees: string
    noAudience: string
  }
  formatDate: (iso: string) => string
}) {
  const noAudience = exam.eligible === 0

  return (
    <Card className="flex flex-col">
      <CardHeader className="gap-2">
        <div className="flex items-start justify-between gap-2">
          <CardTitle className="text-base">
            <Link
              href={`/exams/${exam.id}`}
              className="inline-flex min-h-11 min-w-11 items-center hover:underline md:min-h-0 md:min-w-0"
            >
              {exam.title}
            </Link>
          </CardTitle>
          <ExamStateBadge state={exam.state} label={stateLabel} className="shrink-0" />
        </div>
        {exam.paperNo !== null && (
          <p className="text-body-sm text-muted-foreground">
            {labels.paper} {exam.paperNo}
          </p>
        )}
      </CardHeader>

      <CardContent className="flex flex-1 flex-col justify-between gap-4">
        {/* Wrapping row, not a grid: at 768px the sidebar appears while cards
            are already two-up, and fixed columns crush the numbers. */}
        <ul className="flex flex-wrap gap-x-3 gap-y-1.5 rounded-lg border p-2">
          <Fact icon={ListChecksIcon} label={`${exam.questionCount ?? 0} ${labels.questions}`} />
          <Fact icon={TargetIcon} label={`${exam.totalMarks ?? 0} ${labels.marks}`} />
          <Fact icon={TimerIcon} label={`${exam.durationMinutes} ${labels.duration}`} />
        </ul>

        <dl className="space-y-1 text-body-sm">
          {exam.opensAt && (
            <div className="flex gap-2">
              <dt className="text-muted-foreground">{labels.starts}</dt>
              <dd>{formatDate(exam.opensAt)}</dd>
            </div>
          )}
          {exam.closesAt && (
            <div className="flex gap-2">
              <dt className="flex items-center gap-1.5 text-muted-foreground">
                <ClockIcon aria-hidden className="size-3.5 shrink-0" />
                {labels.deadline}
              </dt>
              <dd className="font-medium">{formatDate(exam.closesAt)}</dd>
            </div>
          )}
        </dl>

        {/*
          An exam with no audience is not "0% attempted" — it is unfinished
          setup, and a 0% bar would read as nobody bothering rather than
          nobody having been asked.
        */}
        {noAudience ? (
          <p className="flex items-start gap-2 rounded-lg border border-dashed border-warning/50 bg-warning/5 p-2.5 text-body-sm">
            <UsersIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
            {labels.noAudience}
          </p>
        ) : (
          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-label-caps text-muted-foreground">{labels.attempts}</span>
              <span className="tabular-nums">
                <span className="text-title-md">{exam.inProgress + exam.submitted}</span>
                <span className="text-muted-foreground">
                  {' / '}
                  {exam.eligible} {labels.ofEmployees}
                </span>
              </span>
            </div>

            <div
              className="relative h-2 overflow-hidden rounded-full bg-muted"
              role="img"
              aria-label={`${exam.attemptPercent}%`}
            >
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-primary/35"
                style={{ width: `${exam.attemptPercent}%` }}
              />
              <div
                className="absolute inset-y-0 left-0 rounded-full bg-primary"
                style={{ width: `${exam.submittedPercent}%` }}
              />
            </div>

            <div className="flex flex-wrap gap-x-4 gap-y-1 text-body-sm text-muted-foreground">
              <span>
                {labels.submitted}{' '}
                <span className="tabular-nums text-foreground">{exam.submitted}</span>
              </span>
              <span>
                {labels.inProgress}{' '}
                <span className="tabular-nums text-foreground">{exam.inProgress}</span>
              </span>
              <span>
                {labels.notStarted}{' '}
                <span className="tabular-nums text-foreground">{exam.notStarted}</span>
              </span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function Fact({ icon: Icon, label }: { icon: typeof TimerIcon; label: string }) {
  return (
    <li className="flex items-center gap-1.5 text-body-sm">
      <Icon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
      {label}
    </li>
  )
}
