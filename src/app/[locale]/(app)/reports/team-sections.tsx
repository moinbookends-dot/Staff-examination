import { getTranslations, getFormatter } from 'next-intl/server'
import { getTeamStats, getExamStats, getQuestionStats } from '@/server/actions/reports'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { AlertTriangleIcon } from 'lucide-react'

/**
 * The sections a chef or HR sees, on the same page as their own record.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE SAMPLE SIZE IS PART OF THE NUMBER, NOT A FOOTNOTE.                    │
 * │                                                                           │
 * │ 0030 returns NULL discrimination below ten responses. This renders that    │
 * │ absence as "not enough responses" rather than as a blank cell or a dash,   │
 * │ because a blank invites the reader to assume zero and a dash invites them  │
 * │ to assume the feature is broken.                                          │
 * │                                                                           │
 * │ Every row carries its n for the same reason. A chef deciding whether to    │
 * │ retire a question is exactly the person who must not be shown a           │
 * │ confident-looking statistic computed from four attempts.                   │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export async function TeamSections() {
  const t = await getTranslations('reports')
  const format = await getFormatter()

  const [team, exams, questions] = await Promise.all([
    getTeamStats(),
    getExamStats(),
    getQuestionStats(),
  ])

  const sat = exams.filter((e) => e.attempts_n > 0)

  return (
    <>
      {/* ── People ── */}
      <Card>
        <CardHeader className="gap-1">
          <CardTitle className="text-base">{t('team')}</CardTitle>
          <p className="text-sm text-muted-foreground">{t('teamHint')}</p>
        </CardHeader>
        <CardContent className="p-0">
          {team.length === 0 ? (
            <p className="p-6 pt-0 text-sm text-muted-foreground">{t('noTeam')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('member')}</TableHead>
                  <TableHead className="text-right">{t('taken')}</TableHead>
                  <TableHead className="text-right">{t('rate')}</TableHead>
                  <TableHead className="text-right">{t('avg')}</TableHead>
                  <TableHead>{t('last')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {team.map((m) => (
                  <TableRow key={m.candidate_id}>
                    <TableCell className="font-medium">{m.full_name}</TableCell>
                    <TableCell className="text-right tabular-nums">{m.attempts_n}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {/* Null, not zero — they have not sat anything, which is
                          not the same as having failed everything. */}
                      {m.pass_rate != null ? t('percentValue', { value: m.pass_rate }) : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {m.avg_percent != null ? t('percentValue', { value: m.avg_percent }) : '—'}
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {m.last_attempt_at ? (
                        format.dateTime(new Date(m.last_attempt_at), { dateStyle: 'medium' })
                      ) : (
                        <Badge variant="outline">{t('neverSat')}</Badge>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* ── Exams ── */}
      <Card>
        <CardHeader className="gap-1">
          <CardTitle className="text-base">{t('exams')}</CardTitle>
          <p className="text-sm text-muted-foreground">{t('examsHint')}</p>
        </CardHeader>
        <CardContent className="p-0">
          {sat.length === 0 ? (
            <p className="p-6 pt-0 text-sm text-muted-foreground">{t('noExams')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('exams')}</TableHead>
                  <TableHead className="text-right">{t('taken')}</TableHead>
                  <TableHead className="text-right">{t('candidates')}</TableHead>
                  <TableHead className="text-right">{t('rate')}</TableHead>
                  <TableHead className="text-right">{t('median')}</TableHead>
                  <TableHead className="text-right">{t('duration')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {sat.map((e) => (
                  <TableRow key={e.exam_id}>
                    <TableCell className="font-medium">{e.title}</TableCell>
                    <TableCell className="text-right tabular-nums">{e.attempts_n}</TableCell>
                    <TableCell className="text-right tabular-nums">{e.candidates_n}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {e.pass_rate != null ? t('percentValue', { value: e.pass_rate }) : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {e.median_percent != null
                        ? t('percentValue', { value: e.median_percent })
                        : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {e.avg_minutes != null ? t('minutes', { value: e.avg_minutes }) : '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* ── Questions ── */}
      <Card>
        <CardHeader className="gap-1">
          <CardTitle className="text-base">{t('questions')}</CardTitle>
          <p className="text-sm text-muted-foreground">{t('questionsHint')}</p>
        </CardHeader>
        <CardContent className="p-0">
          {questions.length === 0 ? (
            <p className="p-6 pt-0 text-sm text-muted-foreground">{t('noQuestions')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('question')}</TableHead>
                  <TableHead className="text-right">{t('responses')}</TableHead>
                  <TableHead className="text-right">{t('facility')}</TableHead>
                  <TableHead className="text-right">{t('rated')}</TableHead>
                  <TableHead className="text-right">{t('behaves')}</TableHead>
                  <TableHead>{t('discrimination')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {questions.map((q) => (
                  <TableRow key={`${q.question_id}-${q.question_revision}`}>
                    <TableCell>
                      <div className="max-w-md space-y-1">
                        <p className="line-clamp-2 font-medium">{q.stem}</p>
                        <p className="text-xs text-muted-foreground">
                          {q.category_name}
                          {' · '}
                          {/* Named, because two revisions appear as two rows and
                              they would otherwise look like duplicates. */}
                          {t('revision', { n: q.question_revision })}
                        </p>
                        {q.misrated && (
                          <Badge variant="outline" className="gap-1 text-amber-700 dark:text-amber-500">
                            <AlertTriangleIcon className="size-3" />
                            {t('misrated')}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{q.attempts_n}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {q.facility != null
                        ? t('percentValue', { value: Math.round(q.facility * 100) })
                        : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{q.author_difficulty}</TableCell>
                    <TableCell className="text-right tabular-nums">
                      {q.observed_difficulty}
                    </TableCell>
                    <TableCell>
                      {q.discrimination != null ? (
                        <span className="tabular-nums">{q.discrimination}</span>
                      ) : (
                        // Spelled out rather than left blank: a blank cell reads
                        // as zero, and a dash reads as broken.
                        <span className="text-xs text-muted-foreground">{t('notEnough')}</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </>
  )
}
