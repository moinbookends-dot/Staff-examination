import { getTranslations, getFormatter } from 'next-intl/server'
import { requirePermission } from '@/lib/auth/guards'
import { listMyExams } from '@/server/actions/attempts'
import { StartExamButton } from './start-exam-button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import { ClipboardListIcon, ClockIcon, ListChecksIcon, TargetIcon, TimerIcon } from 'lucide-react'

/**
 * What a candidate sees.
 *
 * Deliberately not a table. The authoring side lists exams for somebody
 * comparing and managing many; this side is one person with two or three things
 * to do, usually on a phone, often standing up. So: cards, one obvious action
 * each, and the only numbers that change what they do — how long it takes, how
 * many attempts are left, and when it shuts.
 *
 * Nothing here filters by assignment. 0015's policy on `exams` does that from
 * JWT claims, so a candidate cannot be shown an exam the database would refuse
 * them, and there is no second definition of "assigned to me" to drift.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE CLOSING DATE IS PROMOTED, AND THE ATTEMPT COUNT IS NOT.               │
 * │                                                                           │
 * │ Both were previously one line of muted text among four. Only one of them  │
 * │ can cost somebody their chance to sit the paper by being missed, and it   │
 * │ is not "2 of 3 attempts used". So the window gets a badge of its own when │
 * │ it exists, and everything else stays in the quiet list underneath.        │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export default async function MyExamsPage() {
  await requirePermission('attempts.take')
  const t = await getTranslations('sitting')
  const format = await getFormatter()

  const exams = await listMyExams()

  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('subtitle')} />

      {exams.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState icon={ClipboardListIcon} message={t('empty')} hint={t('emptyHint')} />
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {exams.map((exam) => {
            const exhausted = exam.attempts_used >= exam.max_attempts && !exam.open_attempt_id

            return (
              <Card key={exam.id} className="flex flex-col">
                <CardHeader className="gap-2">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-base">{exam.title}</CardTitle>
                    {exam.open_attempt_id ? (
                      <Badge variant="info" className="shrink-0">
                        {t('inProgress')}
                      </Badge>
                    ) : exhausted ? (
                      <Badge variant="secondary" className="shrink-0">
                        {t('noAttemptsLeft')}
                      </Badge>
                    ) : null}
                  </div>
                  {exam.description && (
                    <CardDescription className="line-clamp-2">{exam.description}</CardDescription>
                  )}
                </CardHeader>

                <CardContent className="flex flex-1 flex-col justify-between gap-4">
                  <div className="space-y-3">
                    {/* The three numbers that decide whether to start now. */}
                    <dl className="grid grid-cols-3 gap-2 rounded-lg border p-2 text-center">
                      <Fact
                        icon={TimerIcon}
                        label={t('minutes', { count: exam.duration_minutes })}
                      />
                      {exam.question_count != null && (
                        <Fact
                          icon={ListChecksIcon}
                          label={t('questionCount', { count: exam.question_count })}
                        />
                      )}
                      <Fact
                        icon={TargetIcon}
                        label={t('passMark', { percent: exam.pass_mark_percent })}
                      />
                    </dl>

                    <div className="space-y-1 text-sm text-muted-foreground">
                      <p>
                        {exhausted
                          ? t('noAttemptsLeft')
                          : t('attemptsUsed', {
                              used: exam.attempts_used,
                              max: exam.max_attempts,
                            })}
                      </p>
                      {exam.closes_at && (
                        <p className="flex items-center gap-1.5 font-medium text-warning">
                          <ClockIcon aria-hidden className="size-3.5 shrink-0" />
                          {t('closes', {
                            date: format.dateTime(new Date(exam.closes_at), {
                              dateStyle: 'medium',
                              timeStyle: 'short',
                            }),
                          })}
                        </p>
                      )}
                      {exam.last_status && !exam.open_attempt_id && (
                        <p>
                          {/* Released or not — the database decided, and an
                              unreleased attempt has no score to print anyway. */}
                          {exam.last_published
                            ? t('lastScore', {
                                score: exam.last_score ?? 0,
                                max: exam.total_marks ?? 0,
                              })
                            : t('awaitingResult')}
                        </p>
                      )}
                    </div>
                  </div>

                  <StartExamButton
                    examId={exam.id}
                    openAttemptId={exam.open_attempt_id}
                    disabled={exhausted}
                  />
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}

function Fact({ icon: Icon, label }: { icon: typeof TimerIcon; label: string }) {
  return (
    <div className="min-w-0">
      <dt className="sr-only">{label}</dt>
      <dd className="flex flex-col items-center gap-1 text-xs">
        <Icon aria-hidden className="size-4 text-muted-foreground" />
        <span className="truncate">{label}</span>
      </dd>
    </div>
  )
}
