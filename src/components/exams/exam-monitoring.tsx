import { getTranslations, getFormatter } from 'next-intl/server'
import { Badge } from '@/components/ui/badge'
import { StatCard } from '@/components/papers/stat-card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import type { ParticipantRow } from '@/server/exams/live'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Who has sat this exam, and how they did.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ A SCORE APPEARS HERE ONLY ONCE THE CANDIDATE HAS BEEN GIVEN IT.           ║
 * ║                                                                           ║
 * ║ 0064's exam_participants() returns null for score and passed until the    ║
 * ║ attempt reaches `published`. That is not squeamishness — an exam set to   ║
 * ║ release on close exists precisely so nobody sees results early, and a     ║
 * ║ monitoring table showing them to a chef who then mentions one in the      ║
 * ║ kitchen would make the setting a lie.                                     ║
 * ║                                                                           ║
 * ║ The withholding is done by the DATABASE. This component renders a dash    ║
 * ║ because it received null, not because it decided to hide anything.        ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */

const STATE_TONE: Record<ParticipantRow['state'], string> = {
  released: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400',
  submitted: 'border-sky-500/40 text-sky-700 dark:text-sky-400',
  in_progress: 'border-amber-500/40 text-amber-700 dark:text-amber-400',
  expired: 'border-destructive/40 text-destructive',
  not_started: 'border-muted-foreground/30 text-muted-foreground',
}

export interface Participation {
  eligible: number
  notStarted: number
  inProgress: number
  submitted: number
  released: number
  attemptPercent: number
  submittedPercent: number
}

export async function ExamMonitoring({
  participation,
  participants,
  canSeeTable,
}: {
  participation: Participation
  participants: ParticipantRow[]
  canSeeTable: boolean
}) {
  const t = await getTranslations('exams')
  const format = await getFormatter()

  const when = (iso: string | null) =>
    iso
      ? format.dateTime(new Date(iso), {
          day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
        })
      : '—'

  return (
    <div className="space-y-4">
      <section className="rounded-xl border bg-card p-5">
        <h2 className="text-title-md">{t('monParticipation')}</h2>

        <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard
            label={t('monEligible')}
            value={participation.eligible.toLocaleString()}
            tone="primary"
          />
          <StatCard label={t('monNotStarted')} value={participation.notStarted.toLocaleString()} />
          <StatCard label={t('monInProgress')} value={participation.inProgress.toLocaleString()} />
          <StatCard label={t('monSubmitted')} value={participation.submitted.toLocaleString()} />
        </div>

        <dl className="mt-4 grid gap-4 sm:grid-cols-2">
          <Rate label={t('monAttemptRate')} percent={participation.attemptPercent} />
          <Rate label={t('monSubmitRate')} percent={participation.submittedPercent} />
        </dl>
      </section>

      <section className="rounded-xl border bg-card p-5">
        <h2 className="text-title-md">{t('monTable')}</h2>

        {/*
          Absent rather than disabled. A chef holds attempts.read_team and sees
          this; an Editor holds neither read_team nor read_all, and rendering
          an empty table for them would imply nobody has sat the exam.
        */}
        {!canSeeTable ? (
          <p className="mt-3 text-body-sm text-muted-foreground">{t('monNoAccess')}</p>
        ) : participants.length === 0 ? (
          <p className="mt-3 text-body-sm text-muted-foreground">{t('monNobody')}</p>
        ) : (
          <div className="mt-4 overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('monEmployee')}</TableHead>
                  <TableHead>{t('monDepartment')}</TableHead>
                  <TableHead>{t('monStarted')}</TableHead>
                  <TableHead>{t('monSubmittedCol')}</TableHead>
                  <TableHead>{t('monStatus')}</TableHead>
                  <TableHead className="text-right">{t('monScore')}</TableHead>
                  <TableHead className="text-right">{t('monPercent')}</TableHead>
                  <TableHead>{t('monResult')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {participants.map((p) => {
                  const percent =
                    p.score !== null && p.maxScore
                      ? Math.round((p.score / p.maxScore) * 100)
                      : null

                  return (
                    <TableRow key={p.employeeId}>
                      <TableCell className="font-medium">{p.fullName || p.email}</TableCell>
                      <TableCell className="text-muted-foreground">{p.department ?? '—'}</TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">
                        {when(p.startedAt)}
                      </TableCell>
                      <TableCell className="tabular-nums text-muted-foreground">
                        {when(p.submittedAt)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline" className={cn(STATE_TONE[p.state])}>
                          {t(
                            (p.state === 'not_started' ? 'pNotStarted'
                              : p.state === 'in_progress' ? 'pInProgress'
                              : p.state === 'submitted' ? 'pSubmitted'
                              : p.state === 'expired' ? 'pExpired'
                              : 'pReleased') as 'pNotStarted',
                          )}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {p.score !== null ? `${p.score} / ${p.maxScore ?? 0}` : '—'}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {percent !== null ? `${percent}%` : '—'}
                      </TableCell>
                      <TableCell>
                        {p.passed === null ? (
                          <span className="text-body-sm text-muted-foreground">
                            {p.state === 'not_started' ? '—' : t('resultPending')}
                          </span>
                        ) : (
                          <Badge
                            variant="outline"
                            className={
                              p.passed
                                ? 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400'
                                : 'border-destructive/40 text-destructive'
                            }
                          >
                            {p.passed ? t('resultPass') : t('resultFail')}
                          </Badge>
                        )}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>
        )}
      </section>
    </div>
  )
}

function Rate({ label, percent }: { label: string; percent: number }) {
  return (
    <div className="rounded-lg border p-4">
      <dt className="text-label-caps text-muted-foreground">{label}</dt>
      <dd className="mt-2 flex items-center gap-3">
        <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
          <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
        </div>
        <span className="text-title-md tabular-nums">{percent}%</span>
      </dd>
    </div>
  )
}
