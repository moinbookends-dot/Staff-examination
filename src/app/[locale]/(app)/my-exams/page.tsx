import { getTranslations, getFormatter } from 'next-intl/server'
import { requirePermission } from '@/lib/auth/guards'
import { listMyExams } from '@/server/actions/attempts'
import { StartExamButton } from './start-exam-button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ClipboardListIcon } from 'lucide-react'

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
 */
export default async function MyExamsPage() {
  await requirePermission('attempts.take')
  const t = await getTranslations('sitting')
  const format = await getFormatter()

  const exams = await listMyExams()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      {exams.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <ClipboardListIcon className="size-8 text-muted-foreground" />
            <p className="text-sm font-medium">{t('empty')}</p>
            <p className="text-sm text-muted-foreground">{t('emptyHint')}</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {exams.map((exam) => {
            const exhausted = exam.attempts_used >= exam.max_attempts && !exam.open_attempt_id

            return (
              <Card key={exam.id} className="flex flex-col">
                <CardHeader className="gap-2">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-base">{exam.title}</CardTitle>
                    {exam.open_attempt_id && (
                      <Badge variant="secondary" className="shrink-0">
                        {t('inProgress')}
                      </Badge>
                    )}
                  </div>
                  {exam.description && (
                    <CardDescription className="line-clamp-2">{exam.description}</CardDescription>
                  )}
                </CardHeader>

                <CardContent className="flex flex-1 flex-col justify-between gap-4">
                  <dl className="space-y-1 text-sm text-muted-foreground">
                    <div className="flex flex-wrap gap-x-3">
                      <span>{t('minutes', { count: exam.duration_minutes })}</span>
                      {exam.question_count != null && (
                        <span>{t('questionCount', { count: exam.question_count })}</span>
                      )}
                      {exam.total_marks != null && (
                        <span>{t('markCount', { count: exam.total_marks })}</span>
                      )}
                    </div>
                    <div>{t('passMark', { percent: exam.pass_mark_percent })}</div>
                    <div>
                      {exhausted
                        ? t('noAttemptsLeft')
                        : t('attemptsUsed', { used: exam.attempts_used, max: exam.max_attempts })}
                    </div>
                    {exam.closes_at && (
                      <div>
                        {t('closes', {
                          date: format.dateTime(new Date(exam.closes_at), {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          }),
                        })}
                      </div>
                    )}
                    {exam.last_status && !exam.open_attempt_id && (
                      <div>
                        {exam.last_passed === null
                          ? t('awaitingResult')
                          : t('lastScore', {
                              score: exam.last_score ?? 0,
                              max: exam.total_marks ?? 0,
                            })}
                      </div>
                    )}
                  </dl>

                  <div className="flex justify-end">
                    <StartExamButton
                      examId={exam.id}
                      openAttemptId={exam.open_attempt_id}
                      disabled={exhausted}
                    />
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}
    </div>
  )
}
