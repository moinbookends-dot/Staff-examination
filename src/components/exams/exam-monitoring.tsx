import { getTranslations } from 'next-intl/server'
import { StatCard } from '@/components/papers/stat-card'
import { ParticipantTable } from '@/components/exams/participant-table'
import type { ParticipantRow } from '@/server/exams/live'
import { participantCounts } from '@/lib/analytics/participants'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Who has sat this exam, and how they did.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ A SCORE APPEARS HERE ONLY ONCE THE CANDIDATE HAS BEEN GIVEN IT.           ║
 * ║                                                                           ║
 * ║ 0064's exam_participants() (extended in 0092) returns null for score and  ║
 * ║ passed until the attempt reaches `published`. That is not squeamishness — ║
 * ║ an exam set to release on close exists precisely so nobody sees results   ║
 * ║ early, and a monitoring table showing them to a chef who then mentions    ║
 * ║ one in the kitchen would make the setting a lie.                          ║
 * ║                                                                           ║
 * ║ The withholding is done by the DATABASE. This component renders a dash    ║
 * ║ because it received null, not because it decided to hide anything. The    ║
 * ║ same holds for the spread tiles: exam_score_spread() reads                ║
 * ║ analytics_attempts, so its numbers can never disagree with /reports.      ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * The table itself is a client component — search, filters and sort operate
 * on rows already fetched here, with the logic unit-tested in
 * lib/analytics/participants.ts.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface Participation {
  eligible: number
  notStarted: number
  inProgress: number
  submitted: number
  released: number
  attemptPercent: number
  submittedPercent: number
}

export interface ScoreSpread {
  gradedN: number
  passedN: number
  failedN: number
  avgPercent: number | null
  bestPercent: number | null
  worstPercent: number | null
}

export async function ExamMonitoring({
  participation,
  spread,
  participants,
  canSeeTable,
}: {
  participation: Participation
  spread: ScoreSpread | null
  participants: ParticipantRow[]
  canSeeTable: boolean
}) {
  const t = await getTranslations('exams')

  const pct = (v: number | null) => (v === null ? '—' : `${v}%`)

  /*
   * One truth for the headline numbers. When the caller may see the table,
   * the tiles are counted from the SAME rows the tabs count — they cannot
   * disagree. A caller who may only see participation gets the equivalent
   * arithmetic from exam_participation(): attempted = eligible − not started.
   */
  const counts = canSeeTable
    ? participantCounts(participants)
    : {
        all: participation.eligible,
        attempted:
          participation.eligible - participation.notStarted - participation.inProgress,
        live: participation.inProgress,
        notAttempted: participation.notStarted,
        passed: null as number | null,
        failed: null as number | null,
      }

  return (
    <div className="space-y-4">
      <section className="rounded-xl border bg-card p-5">
        <h2 className="text-title-md">{t('monParticipation')}</h2>

        <div className="mt-4 grid grid-cols-2 gap-4 lg:grid-cols-5">
          <StatCard label={t('tileAssigned')} value={counts.all.toLocaleString()} tone="primary" />
          {/* Attempted here = anyone with an attempt, live included — the
              spec's own arithmetic (attempted = completed + currently live).
              The ATTEMPTED tab below is narrower (ended attempts only), and
              both labels say what they count. */}
          <StatCard
            label={t('tileAttempted')}
            value={(counts.all - counts.notAttempted).toLocaleString()}
          />
          <StatCard label={t('tileLive')} value={counts.live.toLocaleString()} />
          <StatCard label={t('tileCompleted')} value={counts.attempted.toLocaleString()} />
          <StatCard label={t('tileNotAttempted')} value={counts.notAttempted.toLocaleString()} />
        </div>

        <dl className="mt-4 grid gap-4 sm:grid-cols-2">
          <Rate label={t('monAttemptRate')} percent={participation.attemptPercent} />
          <Rate label={t('monSubmitRate')} percent={participation.submittedPercent} />
        </dl>

        {/*
          Outcomes, only for eyes the database already allows: spread is null
          when exam_score_spread refused the caller, and "no numbers" beats a
          row of zeros pretending everybody failed.
        */}
        {spread && spread.gradedN > 0 && (
          <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            <StatCard label={t('monPassedN')} value={spread.passedN.toLocaleString()} />
            <StatCard label={t('monFailedN')} value={spread.failedN.toLocaleString()} />
            <StatCard label={t('monAvg')} value={pct(spread.avgPercent)} />
            <StatCard label={t('monBest')} value={pct(spread.bestPercent)} />
            <StatCard label={t('monWorst')} value={pct(spread.worstPercent)} />
          </div>
        )}
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
          <p className="mt-3 text-body-sm text-muted-foreground">{t('monWaiting')}</p>
        ) : (
          <div className="mt-4">
            <ParticipantTable rows={participants} />
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
        <div
          role="img"
          aria-label={`${label}: ${percent}%`}
          className="h-2 flex-1 overflow-hidden rounded-full bg-muted"
        >
          <div className="h-full rounded-full bg-primary" style={{ width: `${percent}%` }} />
        </div>
        <span className="text-title-md tabular-nums">{percent}%</span>
      </dd>
    </div>
  )
}
