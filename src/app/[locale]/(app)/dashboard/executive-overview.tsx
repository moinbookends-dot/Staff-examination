import { getTranslations } from 'next-intl/server'
import {
  BarChart3Icon,
  ClipboardCheckIcon,
  FileTextIcon,
  GaugeIcon,
  LibraryIcon,
  PlusIcon,
  TrendingUpIcon,
  UserRoundCheckIcon,
} from 'lucide-react'
import type { AppClaims } from '@/lib/auth/claims'
import { can } from '@/lib/auth/claims'
import { getTeamStats, getExamStats } from '@/server/actions/reports'
import { listExams } from '@/server/actions/exams'
import { Link } from '@/lib/i18n/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { StatTile } from '@/components/ui/stat-tile'
import { EmptyState } from '@/components/ui/empty-state'
import { BackendRequired } from '@/components/ui/backend-required'
import { ExportLink } from '@/components/reports/export-link'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The manager half of the dashboard, laid out after the Stitch
 * "Executive Overview" reference.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHAT IS REAL HERE, AND WHAT IS NOT.                                       │
 * │                                                                           │
 * │ Every figure below is computed from a live query. Where the reference     │
 * │ design asks for something this database cannot answer, the panel keeps    │
 * │ its place in the layout and says so — see <BackendRequired> and           │
 * │ docs/backend-required.md. Nothing is estimated, sampled or simulated.     │
 * │                                                                           │
 * │   Live exams        listExams({status:'active'}).total — an exact count,  │
 * │                     `{ count: 'exact' }` on the query, not items.length.  │
 * │   Pending approvals passed in from the page, which already fetched it.    │
 * │   Average score     team_stats(), weighted by attempts_n. NOT the mean of │
 * │                     the per-person means, which would weight somebody     │
 * │                     with one attempt the same as somebody with forty.     │
 * │   Overall pass rate team_stats(), Σpassed_n / Σattempts_n. Both are       │
 * │                     integers, so this is exact rather than a mean of      │
 * │                     rounded rates.                                        │
 * │   By exam           exam_stats(), filtered to papers somebody has sat.    │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * WHY EVERY FIGURE COMES FROM THE ANALYTICS RPCs AND NOT FROM `attempts`.
 * The analytics_attempts view (0030) is the single definition of "which
 * attempts count" — published/verified/evaluated/auto_graded, on an exam
 * flagged counts_towards_analytics, not deleted. Counting the table directly
 * would quietly include practice papers and in-flight attempts, and this page
 * would then disagree with /reports about the same number. Its comment names
 * that failure: "two copies of which attempts count is how two reports quietly
 * disagree about the same number."
 *
 * PERMISSIONS. getTeamStats and getExamStats are guarded on
 * requireAnyPermission(['reports.read_team', 'reports.read_all']), so this
 * component is rendered behind exactly that pair and no wider. A chef reaches
 * it through read_team, HR through read_all. Getting this wrong in the other
 * direction is what made /reports return 500 to every HR user.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export async function ExecutiveOverview({
  claims,
  pendingCount,
}: {
  claims: AppClaims
  /** Already fetched by the page under users.approve; not re-read here. */
  pendingCount: number | null
}) {
  const t = await getTranslations('dashboard')
  const tr = await getTranslations('reports')

  const canExport = can(claims, 'reports.export')
  const canReadExams = can(claims, 'exams.read')
  const canCreateExam = can(claims, 'exams.create')
  const canReadQuestions = can(claims, 'questions.read')
  const canEvaluate = can(claims, 'evaluation.evaluate')

  const [team, exams, live] = await Promise.all([
    getTeamStats(),
    getExamStats(),
    canReadExams ? listExams({ status: 'active' }) : null,
  ])

  // Weighted, not averaged-again. Σ(avg × n) / Σn is the true mean across every
  // attempt; the mean of the per-person means is a different and wrong number
  // whenever people have sat different amounts, which is always.
  let attemptsTotal = 0
  let passedTotal = 0
  let weightedScore = 0
  for (const member of team) {
    attemptsTotal += member.attempts_n
    passedTotal += member.passed_n
    if (member.avg_percent != null) weightedScore += member.avg_percent * member.attempts_n
  }

  // NULL, not zero. Nobody having sat anything is not a 0% pass rate — that
  // would be the claim that everybody failed. 0030 returns null for this and
  // the page has to keep saying null.
  const passRate = attemptsTotal > 0 ? Math.round((passedTotal / attemptsTotal) * 100) : null
  const avgScore = attemptsTotal > 0 ? Math.round(weightedScore / attemptsTotal) : null

  const sat = exams
    .filter((exam) => exam.attempts_n > 0 && exam.pass_rate != null)
    .sort((a, b) => (a.pass_rate ?? 0) - (b.pass_rate ?? 0))
    .slice(0, 5)

  const quickActions = [
    canCreateExam && { href: '/exams/new', label: t('qaNewExam'), icon: PlusIcon },
    canReadQuestions && { href: '/questions', label: t('qaQuestions'), icon: LibraryIcon },
    canEvaluate && { href: '/evaluate', label: t('qaEvaluate'), icon: ClipboardCheckIcon },
    { href: '/reports', label: t('qaReports'), icon: BarChart3Icon },
  ].filter(Boolean) as { href: string; label: string; icon: typeof PlusIcon }[]

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-heading text-lg font-semibold tracking-tight">{t('overview')}</h2>
          <p className="text-sm text-muted-foreground">{t('overviewHint')}</p>
        </div>
        {canExport && <ExportLink dataset="team" label={t('exportReport')} />}
      </div>

      {/* ── The rail, and the hero beside it ──────────────────────────────
          Stitch stacks three narrow tiles down the left with a tall hero to
          their right. Below xl that becomes a plain 2-up grid: a 1/4-width
          column of three tiles at 375px is three unreadable slivers. */}
      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        <div className="grid gap-4 sm:grid-cols-3 xl:grid-cols-1">
          {live && (
            <StatTile label={t('liveExams')} value={String(live.total)} icon={FileTextIcon} />
          )}
          {pendingCount !== null && (
            <StatTile
              label={t('toApprove')}
              value={String(pendingCount)}
              icon={UserRoundCheckIcon}
            />
          )}
          <StatTile
            label={t('avgScore')}
            value={avgScore != null ? tr('percentValue', { value: avgScore }) : '—'}
            icon={GaugeIcon}
          />
        </div>

        {/* The hero. One number, big, because it is the number a manager opens
            this page to see. */}
        <Card className="relative overflow-hidden">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              backgroundImage:
                'radial-gradient(24rem 16rem at 85% 0%, var(--primary), transparent 65%)',
              opacity: 0.1,
            }}
          />
          <CardContent className="relative flex h-full flex-col justify-center gap-1 py-8">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {t('overallPassRate')}
            </p>
            {passRate != null ? (
              <>
                <p className="font-heading text-5xl font-semibold tracking-tight tabular-nums">
                  {tr('percentValue', { value: passRate })}
                </p>
                <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <TrendingUpIcon aria-hidden className="size-4" />
                  {t('passRateOf', { passed: passedTotal, attempts: attemptsTotal })}
                </p>
              </>
            ) : (
              <p className="font-heading text-2xl font-semibold tracking-tight">{t('noTeamYet')}</p>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── Quick actions ───────────────────────────────────────────────────
          Stitch's 2×2 icon grid. Permission-gated, so nobody is offered a
          button that will 403 — and the grid reflows rather than leaving a
          hole when one is withheld. */}
      {quickActions.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('quickActions')}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              {quickActions.map((action) => (
                <Link
                  key={action.href}
                  href={action.href}
                  className="flex min-h-11 flex-col items-center justify-center gap-1.5 rounded-lg border p-3 text-center text-sm font-medium transition-colors hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  <action.icon aria-hidden className="size-4 text-primary" />
                  {action.label}
                </Link>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ── Performance by exam ──────────────────────────────────────────
            Stitch's "Department Performance" bar list, pointed at the rollup
            this database actually has. Weakest first: a list of things that
            are fine, sorted by how fine they are, is not a worklist. */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('examPerformance')}</CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {sat.length === 0 ? (
              <EmptyState icon={BarChart3Icon} message={tr('noExams')} />
            ) : (
              <ul className="space-y-4 px-6 pb-2">
                {sat.map((exam) => {
                  const pct = Math.round(exam.pass_rate ?? 0)
                  return (
                    <li key={exam.exam_id} className="space-y-1.5">
                      <div className="flex items-baseline justify-between gap-3 text-sm">
                        <span className="min-w-0 truncate">{exam.title}</span>
                        <span className="shrink-0 font-medium tabular-nums">
                          {tr('percentValue', { value: pct })}
                        </span>
                      </div>
                      <div
                        role="img"
                        aria-label={`${exam.title}: ${pct}%`}
                        className="h-2 w-full overflow-hidden rounded-full bg-muted"
                      >
                        <div
                          className="h-full rounded-full bg-primary"
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {tr('responses')}: {exam.attempts_n} · {tr('candidates')}:{' '}
                        {exam.candidates_n}
                      </p>
                    </li>
                  )
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        {/* ── Everything the design asks for that this database cannot answer ── */}
        <div className="space-y-4">
          <BackendRequired
            title={t('weeklyEngagement')}
            label={t('backendRequired')}
            description={t('weeklyEngagementHint')}
            requirement="Needs engagement_by_week(p_weeks int) returning (week_start date, started int, completed int, kind exam_kind). analytics_attempts has no time bucketing and attempts.started_at is not exposed by any RPC. See docs/backend-required.md §1."
          >
            {/* An inert axis, so the panel holds the shape it will have. */}
            <div aria-hidden className="flex h-24 items-end gap-1.5 opacity-30">
              {[38, 52, 44, 61, 49, 57, 66].map((h, i) => (
                <div key={i} className="flex-1 rounded-t bg-muted" style={{ height: `${h}%` }} />
              ))}
            </div>
          </BackendRequired>

          <BackendRequired
            title={t('departmentPerformance')}
            label={t('backendRequired')}
            description={t('departmentPerformanceHint')}
            requirement="Needs department_stats() returning (department_id, department_name, outlet_id, outlet_name, attempts_n, passed_n, avg_percent). team_stats() carries outlet_id but no department_id and no names, so no rollup is possible client-side. See docs/backend-required.md §3."
          />

          <BackendRequired
            title={t('liveActivity')}
            label={t('backendRequired')}
            description={t('liveActivityHint')}
            requirement="BLOCKED ON RLS, not on a query. audit_logs exists and is indexed, but policy audit_logs_read (0006) is `using (has_perm('audit.read'))` with NO company_id predicate — reading it here would show one company's activity to another. The policy must be scoped to my_company() before any feed is built. See docs/backend-required.md §4."
          />
        </div>
      </div>
    </section>
  )
}
