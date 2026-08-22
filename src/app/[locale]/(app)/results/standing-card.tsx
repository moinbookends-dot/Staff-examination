import { getTranslations } from 'next-intl/server'
import { MedalIcon, TrendingUpIcon, UsersIcon, ShieldQuestionIcon } from 'lucide-react'
import { getMyStanding } from '@/server/actions/reports'
import { Card, CardContent } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * "Where you stand" — the candidate half of the leaderboard.
 *
 * Laid out after the Stitch Excellence Leaderboard's hero, and deliberately
 * NOT after its podium. That design ranks named colleagues against each other;
 * this is the same screen for somebody who is only entitled to know about
 * themselves.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE SUPPRESSED STATE IS THE FEATURE, NOT THE FALLBACK.                    │
 * │                                                                           │
 * │ Below ten participants my_standing() returns nulls and suppressed = true, │
 * │ and this renders an explanation rather than a blank or a dash. The        │
 * │ sentence says WHY, because "not enough participants yet" without a reason │
 * │ reads as a broken feature, and the reason is the interesting part: in a   │
 * │ four-person kitchen, "3rd of 4" is not a fact about you. It is the exact  │
 * │ statement that two named colleagues scored above you.                     │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Nothing here can render the strings "Passed" or "Not passed". The render
 * check asserts their absence across the WHOLE of /results before a result is
 * released, as a leak check — so a widget on this page whose label happened to
 * be one of those two words would fail the suite as a security regression
 * while leaking nothing at all.
 */
export async function StandingCard() {
  const t = await getTranslations('results')
  const tr = await getTranslations('reports')

  const standing = await getMyStanding()
  if (!standing) return null

  // No released result: not a suppression, and it must not read like one.
  if (standing.best_percent === null) {
    return (
      <Card>
        <CardContent className="p-0">
          <EmptyState
            icon={ShieldQuestionIcon}
            message={t('standingNone')}
            hint={t('standingNoneHint')}
          />
        </CardContent>
      </Card>
    )
  }

  const best = tr('percentValue', { value: Math.round(Number(standing.best_percent)) })

  return (
    <Card className="relative overflow-hidden">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage: 'radial-gradient(22rem 14rem at 88% 0%, var(--primary), transparent 65%)',
          opacity: 0.09,
        }}
      />
      <CardContent className="relative space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="font-heading text-base font-semibold tracking-tight">{t('standing')}</h2>
            <p className="text-sm text-muted-foreground">{t('standingHint')}</p>
          </div>
          <span className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground">
            {t('standingScope')}
          </span>
        </div>

        <dl className="grid gap-4 sm:grid-cols-3">
          <Figure icon={MedalIcon} label={t('yourBest')} value={best} />

          {standing.suppressed ? (
            // One cell across the remaining two columns: there is nothing to
            // put in the other, and two empty tiles read as a loading state.
            <div className="sm:col-span-2">
              <p className="text-sm font-medium">{t('standingSuppressed')}</p>
              <p className="mt-1 text-sm text-pretty text-muted-foreground">
                {t('standingSuppressedHint')}
              </p>
            </div>
          ) : (
            <>
              <Figure
                icon={TrendingUpIcon}
                label={t('yourRank')}
                value={t('rankOf', {
                  rank: standing.rank_position ?? 0,
                  total: standing.cohort_n ?? 0,
                })}
              />
              <Figure
                icon={UsersIcon}
                label={t('yourPercentile')}
                value={t('topPercent', { percent: 100 - (standing.percentile ?? 0) })}
              />
            </>
          )}
        </dl>
      </CardContent>
    </Card>
  )
}

function Figure({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof MedalIcon
  label: string
  value: string
}) {
  return (
    <div>
      <dt className="flex items-center gap-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">
        <Icon aria-hidden className="size-3.5" />
        {label}
      </dt>
      <dd className="mt-1 font-heading text-2xl font-semibold tabular-nums">{value}</dd>
    </div>
  )
}
