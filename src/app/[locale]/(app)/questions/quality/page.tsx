import { getTranslations } from 'next-intl/server'
import { requirePermission } from '@/lib/auth/guards'
import { Link } from '@/lib/i18n/navigation'
import { getBankQuality, getBankRecommendations, getQuestionQuality } from '@/server/actions/quality'
import {
  groupDistribution,
  needsAttention,
  shareOf,
  VERDICT_TONE,
  type BankDistribution,
  type QuestionQualityRow,
} from '@/lib/questions/quality'
import { blockingIssues } from '@/lib/exams/health'
import { HealthIssueList } from '@/components/health/issue-list'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { StatTile } from '@/components/ui/stat-tile'
import { buttonVariants } from '@/components/ui/button'
import { ArrowLeftIcon } from 'lucide-react'

/**
 * The quality dashboard.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ EVERY NUMBER ON THIS PAGE COMES FROM A QUERY. NOTHING IS ESTIMATED.       │
 * │                                                                           │
 * │ The distributions are bank_quality(), the advisories are                  │
 * │ bank_recommendations(), the verdicts are question_quality(). Where a      │
 * │ signal does not exist yet the page says so rather than approximating it — │
 * │ the rule the executive dashboard was built under, and the reason          │
 * │ docs/backend-required.md exists.                                          │
 * │                                                                           │
 * │ The coverage tile is the honest headline. On a young bank almost every    │
 * │ question is `unproven`, and a dashboard that led with "3 problems found"  │
 * │ while silently ignoring 400 unmeasured questions would be describing a    │
 * │ bank nobody has.                                                          │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export default async function QuestionQualityPage() {
  await requirePermission('questions.read')
  const t = await getTranslations('questions.quality')
  const tBloom = await getTranslations('questions.bloom')
  const tTypes = await getTranslations('questions.types')

  const [distribution, recommendations, quality] = await Promise.all([
    getBankQuality(),
    getBankRecommendations(),
    getQuestionQuality(),
  ])

  const grouped = groupDistribution(distribution)
  const measured = quality.filter((q) => q.verdict !== 'unproven')
  const attention = quality.filter((q) => needsAttention(q.verdict))
  const blockers = blockingIssues(recommendations)
  const advisories = recommendations.filter((i) => i.severity === 'advisory')

  const labelFor = (dimension: string, bucket: string, isMissing: boolean | null) => {
    if (isMissing) return t('unset')
    if (dimension === 'bloom') return tBloom(bucket)
    if (dimension === 'type') return tTypes(bucket)
    return bucket
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <Link href="/questions" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
          <ArrowLeftIcon />
          {t('backToBank')}
        </Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatTile label={t('drawable')} value={String(quality.length)} hint={t('drawableHint')} />
        {/*
         * Coverage before findings, deliberately. "2 questions need attention"
         * means something very different when 6 of 400 have ever been measured,
         * and putting the denominator second is how a dashboard misleads
         * without stating anything false.
         */}
        <StatTile
          label={t('measured')}
          value={`${measured.length} / ${quality.length}`}
          hint={t('measuredHint')}
        />
        <StatTile
          label={t('needsAttention')}
          value={String(attention.length)}
          hint={t('needsAttentionHint')}
        />
      </div>

      {recommendations.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('recommendations')}</CardTitle>
            <CardDescription>{t('recommendationsHint')}</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {/* The same component and the same remedy map the exam health panel
                uses. bank_recommendations returns exam_health's exact shape so
                that this is possible rather than merely convenient. */}
            {blockers.length > 0 && <HealthIssueList issues={blockers} tone="blocking" />}
            {advisories.length > 0 && <HealthIssueList issues={advisories} tone="advisory" />}
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {(['bloom', 'difficulty', 'category', 'type'] as const).map((dimension) => {
          const rows = grouped.get(dimension) ?? []
          return (
            <Card key={dimension}>
              <CardHeader>
                <CardTitle className="text-base">{t(`dimension.${dimension}`)}</CardTitle>
                <CardDescription>{t(`dimensionHint.${dimension}`)}</CardDescription>
              </CardHeader>
              <CardContent>
                {rows.length === 0 ? (
                  <p className="text-sm text-muted-foreground">{t('noQuestions')}</p>
                ) : (
                  <Distribution
                    rows={rows}
                    label={(row) => labelFor(dimension, row.bucket, row.is_missing)}
                  />
                )}
              </CardContent>
            </Card>
          )
        })}
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('questions')}</CardTitle>
          <CardDescription>{t('questionsHint')}</CardDescription>
        </CardHeader>
        <CardContent>
          {quality.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t('noQuestions')}</p>
          ) : (
            <QualityList rows={quality.slice(0, 50)} t={t} />
          )}
        </CardContent>
      </Card>
    </div>
  )
}

/**
 * A distribution as a labelled bar list.
 *
 * A list and not a pie or a donut: the question these answer is "is anything
 * badly over-represented", which is a comparison of lengths against each other,
 * and lengths are the one thing people read accurately. Every row also carries
 * its raw count, because a percentage of a bank of nine questions is noise.
 */
function Distribution({
  rows,
  label,
}: {
  rows: BankDistribution[]
  label: (row: BankDistribution) => string
}) {
  const peak = Math.max(...rows.map((r) => r.n), 1)

  return (
    <ul className="space-y-2">
      {rows.map((row) => {
        const share = shareOf(row, rows)
        return (
          <li key={`${row.dimension}-${row.bucket}`} className="grid grid-cols-[8rem_1fr_4rem] items-center gap-2 text-sm">
            <span className={row.is_missing ? 'text-warning' : 'text-muted-foreground'}>
              {label(row)}
            </span>
            {/* Scaled to the largest bucket, not to the total: at 12 categories
                every bar would otherwise be a sliver and the chart would say
                nothing. aria-hidden because the numbers beside it are the
                accessible version — a bar is not readable. */}
            <span className="h-2 rounded-full bg-muted" aria-hidden>
              <span
                className={`block h-2 rounded-full ${row.is_missing ? 'bg-warning' : 'bg-primary'}`}
                style={{ width: `${Math.max(2, (row.n / peak) * 100)}%` }}
              />
            </span>
            <span className="text-right tabular-nums text-muted-foreground">
              {row.n} · {share}%
            </span>
          </li>
        )
      })}
    </ul>
  )
}

function QualityList({
  rows,
  t,
}: {
  rows: QuestionQualityRow[]
  t: Awaited<ReturnType<typeof getTranslations>>
}) {
  return (
    <ul className="divide-y">
      {rows.map((row) => (
        <li key={row.question_id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2 text-sm">
          <Link
            href={`/questions/${row.question_id}`}
            className="min-w-0 flex-1 truncate font-medium underline-offset-4 hover:underline"
          >
            {row.stem}
          </Link>

          <Badge variant={VERDICT_TONE[row.verdict]}>{t(`verdict.${row.verdict}`)}</Badge>

          {/* n is never omitted. 0030's rule: no statistic without its sample
              size, because a facility of 1.00 from two attempts and one from
              two hundred are not the same claim. */}
          <span className="tabular-nums text-muted-foreground">
            {t('sampleSize', { n: row.attempts_n })}
          </span>

          {row.facility !== null && (
            <span className="tabular-nums text-muted-foreground">
              {t('facility', { value: row.facility })}
            </span>
          )}
          {row.discrimination !== null && (
            <span className="tabular-nums text-muted-foreground">
              {t('discrimination', { value: row.discrimination })}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}
