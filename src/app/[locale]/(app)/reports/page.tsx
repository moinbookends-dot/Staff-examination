import { getTranslations, getFormatter } from 'next-intl/server'
import { requirePermission } from '@/lib/auth/guards'
import { can } from '@/lib/auth/claims'
import { getCandidateStats, getCandidateCategoryStats } from '@/server/actions/reports'
import { TeamSections } from './team-sections'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { BarChart3Icon } from 'lucide-react'

/**
 * How one person is doing.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ NO DATA IS NOT ZERO.                                                      │
 * │                                                                           │
 * │ candidate_stats() returns a NULL pass rate for somebody who has sat        │
 * │ nothing, and this page renders that as an empty state rather than as 0%.  │
 * │ "0% pass rate" is a statement that everybody failed — a different and far │
 * │ more alarming claim than "nobody has sat this yet", and the difference    │
 * │ matters most to the person it is about.                                   │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * One route serves three audiences: the nav has a single /reports entry gated
 * on read_own, read_team and read_all together. This slice renders the "own"
 * half, which every one of them holds; the team and question views land on the
 * same page rather than on new routes, so nobody has to learn where to look.
 */
export default async function ReportsPage() {
  const claims = await requirePermission('reports.read_own')
  const t = await getTranslations('reports')
  const format = await getFormatter()

  // Presentation only — the same rule nav.ts states. Which sections to draw is
  // decided here; how far each one may actually look is decided by the database
  // functions, which do their own scoping and would refuse regardless.
  const seesTeam = can(claims, 'reports.read_team') || can(claims, 'reports.read_all')
  const canExport = can(claims, 'reports.export')

  const [stats, categories] = await Promise.all([
    getCandidateStats(),
    getCandidateCategoryStats(),
  ])

  const hasData = (stats?.attempts_n ?? 0) > 0

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      {!hasData ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <BarChart3Icon className="size-8 text-muted-foreground" />
            <p className="text-sm font-medium">{t('noData')}</p>
            <p className="text-sm text-muted-foreground">{t('noDataHint')}</p>
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label={t('attempts')} value={String(stats!.attempts_n)} />
            <Stat
              label={t('passed')}
              value={t('ofAttempts', { passed: stats!.passed_n, total: stats!.attempts_n })}
              hint={
                stats!.pass_rate != null
                  ? t('percentValue', { value: stats!.pass_rate })
                  : undefined
              }
            />
            <Stat
              label={t('average')}
              value={
                stats!.avg_percent != null
                  ? t('percentValue', { value: stats!.avg_percent })
                  : '—'
              }
            />
            <Stat
              label={t('best')}
              value={
                stats!.best_percent != null
                  ? t('percentValue', { value: stats!.best_percent })
                  : '—'
              }
              hint={
                stats!.last_attempt_at
                  ? t('lastAttempt', {
                      date: format.dateTime(new Date(stats!.last_attempt_at), {
                        dateStyle: 'medium',
                      }),
                    })
                  : undefined
              }
            />
          </div>

          <Card>
            <CardHeader className="gap-1">
              <CardTitle className="text-base">{t('strengths')}</CardTitle>
              <p className="text-sm text-muted-foreground">{t('strengthsHint')}</p>
            </CardHeader>
            <CardContent>
              {categories.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('noCategories')}</p>
              ) : (
                <ul className="space-y-3">
                  {categories.map((c) => {
                    // facility is a proportion of available marks, 0–1.
                    const pct = c.facility != null ? Math.round(c.facility * 100) : null
                    return (
                      <li key={c.category_id} className="space-y-1">
                        <div className="flex items-baseline justify-between gap-3 text-sm">
                          <span className="font-medium">{c.category_name}</span>
                          <span className="text-muted-foreground">
                            {pct != null ? t('correctShare', { percent: pct }) : '—'}
                            {' · '}
                            {t('questionsAnswered', { count: c.questions_n })}
                          </span>
                        </div>
                        <div
                          className="h-2 w-full overflow-hidden rounded-full bg-muted"
                          role="img"
                          aria-label={`${c.category_name}: ${pct ?? 0}%`}
                        >
                          <div
                            className="h-full rounded-full bg-primary"
                            style={{ width: `${pct ?? 0}%` }}
                          />
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </>
      )}

      {/* Rendered whether or not the viewer has a record of their own: a chef
          who has sat nothing still needs to see who on their team has. */}
      {seesTeam && <TeamSections canExport={canExport} />}
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <p className="text-xs font-medium text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  )
}
