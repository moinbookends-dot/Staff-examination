import { getTranslations } from 'next-intl/server'
import {
  ArchiveIcon,
  AwardIcon,
  CheckCircle2Icon,
  CalendarClockIcon,
  ClipboardListIcon,
  FilePenLineIcon,
  FileTextIcon,
  LayersIcon,
  RadioIcon,
  SparklesIcon,
  UsersIcon,
} from 'lucide-react'
import { requireApproved } from '@/lib/auth/guards'
import { getAppClaims, can } from '@/lib/auth/claims'
import { canGeneratePapers, canOpenQuestionBank, canReadPaperHistory } from '@/lib/auth/bank-access'
import { listMyExams } from '@/server/actions/attempts'
import { loadLiveSummary } from '@/server/exams/live'
import { Link } from '@/lib/i18n/navigation'
import { PageHeader } from '@/components/ui/page-header'
import { buttonVariants } from '@/components/ui/button'
import { DistributionBar, StatCard } from '@/components/papers/stat-card'
import { loadBankStatistics, loadPaperHistory } from '@/server/papers/availability'
import { DIFFICULTIES } from '@/lib/bank/vocabulary'
import { cn } from '@/lib/utils'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Dashboard, per the Stitch design.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THIS REPLACES THE LEGACY DASHBOARD ENTIRELY.                              ║
 * ║                                                                           ║
 * ║ The previous page was built for the online delivery product: evaluation   ║
 * ║ and verification queues, attempts in progress, released results, and      ║
 * ║ candidate statistics. Every one of those subsystems is being removed.     ║
 * ║                                                                           ║
 * ║ It also linked to /evaluate, /verify and /reports from its own body —     ║
 * ║ routes deliberately taken out of the navigation — so a chef could still   ║
 * ║ reach them by clicking a tile. scripts/check-shell.mjs was failing four   ║
 * ║ assertions on exactly that, and those failures were correct.              ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ EVERY TILE AND EVERY QUICK ACTION IS PERMISSION-GATED.                    │
 * │                                                                           │
 * │ The predicates are evaluated HERE, in a Server Component, and only        │
 * │ booleans and numbers reach the markup. A dashboard is the easiest place   │
 * │ to leak a route somebody may not follow, because a tile does not look     │
 * │ like navigation.                                                          │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */
export default async function DashboardPage() {
  await requireApproved()

  const claims = await getAppClaims()
  const t = await getTranslations('papers')
  // The live-exam card speaks the exams vocabulary, not the papers one.
  const te = await getTranslations('exams')

  const canBank = canOpenQuestionBank(claims)
  const canGenerate = canGeneratePapers(claims)
  const canHistory = canReadPaperHistory(claims)

  /*
   * ┌───────────────────────────────────────────────────────────────────────────┐
   * │ A CANDIDATE IS NOT "EVERYONE ELSE", AND TREATING THEM AS SUCH PUT THE     │
   * │ WRONG DASHBOARD IN FRONT OF THEM.                                         │
   * │                                                                           │
   * │ This page had two branches: the bank view, and a fallback commented "a    │
   * │ chef sees papers only". An Employee holds neither bank.read nor           │
   * │ papers.read_history, so they fell into the chef branch and were shown     │
   * │ "Papers generated" and "Editors" — two counts about a subsystem they      │
   * │ cannot open, both reading 0 because RLS correctly returns them nothing.   │
   * │                                                                           │
   * │ It is the first screen they ever see: the proxy sends them here after     │
   * │ sign-in, / redirects here, and /pending forwards here on approval.        │
   * └───────────────────────────────────────────────────────────────────────────┘
   */
  const isCandidate = !canBank && !canHistory && can(claims, 'attempts.take')

  /*
   * Each query is gated on the screen that will actually render it. The bank
   * statistics used to be fetched for everybody, including candidates who have
   * no tile to put them in — a query run to render nothing.
   */
  // exams.read gates the live summary: it counts attempts across the company,
  // which is not a candidate's business and not an Editor's either.
  const canSeeExams = can(claims, 'exams.read')

  const [stats, history, myExams, live] = await Promise.all([
    canBank || canHistory
      ? loadBankStatistics()
      : Promise.resolve(null),
    canHistory ? loadPaperHistory(1, 5) : Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 5 }),
    isCandidate ? listMyExams() : Promise.resolve([]),
    canSeeExams ? loadLiveSummary() : Promise.resolve(null),
  ])

  const difficultyLabels = {
    easy: t('difficulty.easy'),
    medium: t('difficulty.medium'),
    hard: t('difficulty.hard'),
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('dashTitle')}
        // "The question bank and recent activity" describes a screen a
        // candidate cannot see. They get a line about their own work instead.
        description={isCandidate ? t('dashCandidateSubtitle') : t('dashSubtitle')}
        actions={
          <div className="flex flex-wrap gap-2">
            {canGenerate && (
              <Link href="/papers/generate" className={cn(buttonVariants({ size: 'sm' }))}>
                <SparklesIcon />
                {t('generateTitle')}
              </Link>
            )}
            {canBank && (
              <Link
                href="/questions"
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
              >
                <LayersIcon />
                {t('statTotal')}
              </Link>
            )}
            {canHistory && (
              <Link
                href="/history"
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
              >
                <FileTextIcon />
                {t('historyTitle')}
              </Link>
            )}
          </div>
        }
      />

      {/* ── Live exams, for anyone who runs them ────────────────────────── */}
      {/* Above the bank statistics deliberately: a running exam is time-bound
          and everything below it is not. */}
      {live && (live.live > 0 || live.upcoming > 0 || live.activeAttempts > 0) && (
        <section className="rounded-xl border bg-card p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-title-md">{te('dashLiveTitle')}</h2>
            <Link
              href="/exams/live"
              className="inline-flex min-h-11 items-center text-body-sm font-medium text-primary hover:underline md:min-h-0"
            >
              {te('dashLiveAll')}
            </Link>
          </div>

          <div className="mt-4 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label={te('dashLiveExams')}
              value={live.live.toLocaleString()}
              icon={<RadioIcon className="size-5" />}
              tone="primary"
            />
            <StatCard
              label={te('dashActiveAttempts')}
              value={live.activeAttempts.toLocaleString()}
              hint={te('dashActiveAttemptsHint')}
              icon={<ClipboardListIcon className="size-5" />}
            />
            <StatCard
              label={te('dashSubmittedToday')}
              value={live.submittedToday.toLocaleString()}
              icon={<CheckCircle2Icon className="size-5" />}
            />
            <StatCard
              label={te('dashUpcoming')}
              value={live.upcoming.toLocaleString()}
              icon={<CalendarClockIcon className="size-5" />}
            />
          </div>
        </section>
      )}

      {/* ── A candidate: what they have to sit ──────────────────────────── */}
      {isCandidate && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <StatCard
              label={t('statToSit')}
              value={myExams.filter((e) => !e.open_attempt_id ? e.attempts_used < e.max_attempts : true).length.toLocaleString()}
              hint={t('statToSitHint')}
              icon={<ClipboardListIcon className="size-5" />}
              tone="primary"
            />
            <StatCard
              label={t('statInProgress')}
              value={myExams.filter((e) => e.open_attempt_id).length.toLocaleString()}
              hint={t('statInProgressHint')}
              icon={<CheckCircle2Icon className="size-5" />}
            />
          </div>

          <section className="rounded-xl border bg-card p-5">
            <h2 className="text-title-md">{t('candidateNext')}</h2>
            <p className="mt-1 text-body-sm text-muted-foreground">
              {myExams.length === 0 ? t('candidateNothing') : t('candidateNextHint')}
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Link href="/my-exams" className={cn(buttonVariants({ size: 'sm' }))}>
                <ClipboardListIcon />
                {t('candidateGoToExams')}
              </Link>
              <Link
                href="/results"
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
              >
                <AwardIcon />
                {t('candidateGoToResults')}
              </Link>
            </div>
          </section>
        </>
      )}

      {/* ── Bank statistics — Editors only ──────────────────────────────── */}
      {canBank && stats && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label={t('statTotal')}
              value={stats.total.toLocaleString()}
              icon={<LayersIcon className="size-5" />}
              tone="primary"
            />
            <StatCard
              label={t('statActive')}
              value={stats.active.toLocaleString()}
              hint={t('statActiveHint')}
              icon={<CheckCircle2Icon className="size-5" />}
            />
            <StatCard
              label={t('statDraft')}
              value={stats.draft.toLocaleString()}
              hint={t('statDraftHint')}
              icon={<FilePenLineIcon className="size-5" />}
            />
            <StatCard
              label={t('statArchived')}
              value={stats.archived.toLocaleString()}
              hint={t('statArchivedHint')}
              icon={<ArchiveIcon className="size-5" />}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <section className="rounded-xl border bg-card p-5">
              <h2 className="text-title-md">{t('distributionTitle')}</h2>
              <p className="mt-1 text-body-sm text-muted-foreground">
                {t('distributionHint')}
              </p>
              <div className="mt-4 space-y-4">
                {DIFFICULTIES.map((d) => (
                  <DistributionBar
                    key={d}
                    label={difficultyLabels[d]}
                    count={stats.byDifficulty[d]}
                    /*
                     * ACTIVE, not total. The bars count active questions, so
                     * measuring them against a total that also holds drafts
                     * and archived rows would draw three bars that never fill
                     * the width and never explain why.
                     */
                    total={stats.active}
                  />
                ))}
              </div>
            </section>

            <RecentPapers rows={history.rows} canHistory={canHistory} />
          </div>
        </>
      )}

      {/* ── A chef (or HR) sees papers only ─────────────────────────────── */}
      {/* Gated on canHistory, not on !canBank. The negation swept up every
          role without a bank key — candidates included — and handed them a
          papers dashboard they have no permission to act on. */}
      {!canBank && canHistory && stats && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <StatCard
              label={t('statPapers')}
              value={stats.papersGenerated.toLocaleString()}
              icon={<FileTextIcon className="size-5" />}
              tone="primary"
            />
            <StatCard
              label={t('statAdministrators')}
              value={stats.administrators.toLocaleString()}
              icon={<UsersIcon className="size-5" />}
            />
          </div>
          <RecentPapers rows={history.rows} canHistory={canHistory} />
        </>
      )}
    </div>
  )
}

async function RecentPapers({
  rows,
  canHistory,
}: {
  rows: { id: string; paperNo: number }[]
  canHistory: boolean
}) {
  const t = await getTranslations('papers')

  if (!canHistory) return null

  return (
    <section className="rounded-xl border bg-card p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-title-md">{t('recentPapers')}</h2>
        <Link
          href="/history"
          className="inline-flex min-h-11 items-center text-body-sm text-primary hover:underline md:min-h-0"
        >
          {t('viewAll')}
        </Link>
      </div>

      {rows.length === 0 ? (
        // The honest state while nothing has been generated. No skeleton: the
        // data is loaded, and it is genuinely empty.
        <p className="mt-6 text-body-sm text-muted-foreground">{t('noActivity')}</p>
      ) : (
        <ul className="mt-4 divide-y">
          {rows.map((row) => (
            <li key={row.id} className="py-3 first:pt-0 last:pb-0">
              <Link
                href={`/history/${row.id}`}
                className="inline-flex min-h-11 items-center text-body-sm hover:underline md:min-h-0"
              >
                {t('paperNo', { paperNo: row.paperNo })}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
