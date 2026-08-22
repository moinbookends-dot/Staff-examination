import { getTranslations, getFormatter } from 'next-intl/server'
import { requirePermission } from '@/lib/auth/guards'
import { can } from '@/lib/auth/claims'
import { Link } from '@/lib/i18n/navigation'
import { listMyResults } from '@/server/actions/attempts'
import { StandingCard } from './standing-card'
import { Leaderboard } from './leaderboard'
import { buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import { FileTextIcon, ClockIcon } from 'lucide-react'

/**
 * A candidate's own results, and where they stand.
 *
 * Everything unreleased shows its state and no numbers — not because this page
 * withholds them, but because my_results() returns null for score, percent and
 * passed until the attempt is published. A rendering mistake here cannot leak a
 * mark, because there is no mark in the data to leak.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE RESULT CARDS BELOW ARE STRUCTURALLY FROZEN.                           │
 * │                                                                           │
 * │ render-check.mjs finds the essay result by indexOf(title), then finds the │
 * │ NEXT card by indexOf(otherTitle, from) and asserts over the slice between │
 * │ them. It does that because "no verdict before release" has to be checked  │
 * │ against one card and not the whole page — this candidate legitimately has │
 * │ a released result and a held one at the same time.                        │
 * │                                                                           │
 * │ So: nothing may be inserted BETWEEN two result cards, and their order may │
 * │ not change. Anything new goes above the list, which is where the standing │
 * │ card and the leaderboard are. Reordering, grouping, tabbing or paginating │
 * │ this list collapses that slice and fails a correct page.                  │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export default async function ResultsPage() {
  const claims = await requirePermission('attempts.read_own')
  const t = await getTranslations('results')
  const format = await getFormatter()

  // The same pair the actions are guarded on. team_stats() takes
  // requireAnyPermission(['reports.read_team', 'reports.read_all']), so this
  // gate names both literals and neither more.
  const seesTeam = can(claims, 'reports.read_team') || can(claims, 'reports.read_all')
  const seesOwnStanding = can(claims, 'reports.read_own')

  const results = await listMyResults()

  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('subtitle')} />

      {seesOwnStanding && <StandingCard />}
      {seesTeam && <Leaderboard />}

      {results.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState icon={FileTextIcon} message={t('empty')} hint={t('emptyHint')} />
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {results.map((r) => (
            <Card key={r.attempt_id}>
              <CardHeader className="gap-2">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <CardTitle className="text-base">{r.exam_title}</CardTitle>
                    <p className="text-sm text-muted-foreground">
                      {r.submitted_at
                        ? t('taken', {
                            date: format.dateTime(new Date(r.submitted_at), {
                              dateStyle: 'medium',
                            }),
                          })
                        : ''}
                    </p>
                  </div>

                  {r.published ? (
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="secondary">
                        {t('scoreOf', { score: r.score ?? 0, max: r.max_score ?? 0 })}
                      </Badge>
                      <Badge variant={r.passed ? 'default' : 'outline'}>
                        {r.passed ? t('passed') : t('failed')}
                      </Badge>
                    </div>
                  ) : (
                    <Badge variant="outline" className="gap-1.5">
                      <ClockIcon className="size-3.5" />
                      {t('pending')}
                    </Badge>
                  )}
                </div>
              </CardHeader>

              <CardContent className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-sm text-muted-foreground">
                  {r.published
                    ? `${t('percent', { percent: r.percent ?? 0 })} · ${t('passMark', {
                        percent: r.pass_mark_percent,
                      })}`
                    : t('pendingHint')}
                </p>

                {r.published && (
                  <Link
                    href={`/results/${r.attempt_id}`}
                    className={buttonVariants({ variant: 'outline', size: 'sm' })}
                  >
                    {t('view')}
                  </Link>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  )
}
