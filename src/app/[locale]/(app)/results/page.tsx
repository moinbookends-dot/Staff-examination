import { getTranslations, getFormatter } from 'next-intl/server'
import { requirePermission } from '@/lib/auth/guards'
import { Link } from '@/lib/i18n/navigation'
import { listMyResults } from '@/server/actions/attempts'
import { buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { FileTextIcon, ClockIcon } from 'lucide-react'

/**
 * A candidate's own results.
 *
 * Everything unreleased shows its state and no numbers — not because this page
 * withholds them, but because my_results() returns null for score, percent and
 * passed until the attempt is published. A rendering mistake here cannot leak a
 * mark, because there is no mark in the data to leak.
 */
export default async function ResultsPage() {
  await requirePermission('attempts.read_own')
  const t = await getTranslations('results')
  const format = await getFormatter()

  const results = await listMyResults()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
      </div>

      {results.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center">
            <FileTextIcon className="size-8 text-muted-foreground" />
            <p className="text-sm font-medium">{t('empty')}</p>
            <p className="text-sm text-muted-foreground">{t('emptyHint')}</p>
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
