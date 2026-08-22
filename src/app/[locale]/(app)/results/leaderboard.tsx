import { getTranslations } from 'next-intl/server'
import { TrophyIcon } from 'lucide-react'
import { getTeamStats } from '@/server/actions/reports'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { Badge } from '@/components/ui/badge'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The ranked board, for people entitled to see who is on it.
 *
 * Stitch's "Employee Performance Breakdown" — rank, person, current exam,
 * score, trend, action. Trend is not here: nothing in this schema is
 * period-over-period (docs/backend-required.md §2), and a trend arrow computed
 * from one number is a decoration that asserts a fact.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE SCOPE IS NOT DECIDED HERE, AND THAT IS THE POINT.                     │
 * │                                                                           │
 * │ team_stats() reads analytics_scope() and applies:                         │
 * │                                                                           │
 * │     where p.company_id = my_company()                                     │
 * │       and (v_scope = 'all' or p.outlet_id = my_outlet())                  │
 * │                                                                           │
 * │ so HR (reports.read_all → 'all') gets the company and a chef              │
 * │ (reports.read_team → 'team') gets their outlet, with no branch in this    │
 * │ file at all. Re-deriving the scope in TypeScript would be a second        │
 * │ opinion about who may see whom, and the second opinion is the one that    │
 * │ eventually disagrees.                                                     │
 * │                                                                           │
 * │ A super admin gets 'all' too — which means every outlet in THEIR company, │
 * │ not every company. my_company() is a scalar claim. See                    │
 * │ docs/backend-required.md §6.                                              │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Sorted here rather than in SQL because team_stats() is ordered by name for
 * the /reports table, and a leaderboard wants it by score. Same rows, same
 * scope, different presentation — which is exactly the kind of thing that
 * belongs in the view layer.
 */
export async function Leaderboard() {
  const t = await getTranslations('reports')

  const team = await getTeamStats()

  // People who have sat nothing stay out of the RANKING but are not hidden:
  // team_stats() LEFT JOINs them deliberately so "who still needs to do this"
  // is answerable, and that question belongs on /reports, not on a podium.
  const ranked = team
    .filter((member) => member.attempts_n > 0 && member.avg_percent != null)
    .sort((a, b) => (b.avg_percent ?? 0) - (a.avg_percent ?? 0))

  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle className="text-base">{t('team')}</CardTitle>
          <p className="text-sm text-muted-foreground">{t('teamHint')}</p>
        </div>
      </CardHeader>
      <CardContent className="p-0">
        {ranked.length === 0 ? (
          <EmptyState icon={TrophyIcon} message={t('noTeam')} />
        ) : (
          <ol className="divide-y">
            {ranked.map((member, index) => (
              <li
                key={member.candidate_id}
                className="flex min-h-11 items-center gap-3 px-6 py-3 text-sm"
              >
                {/* The position is a real number in the DOM, not a ::before —
                    it has to survive being read aloud and being copied. */}
                <span
                  className={
                    index < 3
                      ? 'w-7 shrink-0 text-center font-heading text-base font-semibold tabular-nums text-primary'
                      : 'w-7 shrink-0 text-center font-heading text-base font-semibold tabular-nums text-muted-foreground'
                  }
                >
                  {index + 1}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium">{member.full_name}</span>
                <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                  {t('taken')}: {member.attempts_n}
                </span>
                <Badge variant={index === 0 ? 'success' : 'secondary'} className="shrink-0 tabular-nums">
                  {t('percentValue', { value: Math.round(member.avg_percent ?? 0) })}
                </Badge>
              </li>
            ))}
          </ol>
        )}
      </CardContent>
    </Card>
  )
}
