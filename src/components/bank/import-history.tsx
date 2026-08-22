import { getFormatter, getTranslations } from 'next-intl/server'
import { HistoryIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { BANK_LOCALE_LABELS } from '@/lib/bank/vocabulary'
import type { BankImportRun } from '@/lib/bank/types'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * What has been imported into this bank, and by whom.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE COUNTS ARE THE CONTENT. THE STATUS WORD IS NOT.                       │
 * │                                                                           │
 * │ "Import completed" answers nothing. The question somebody arrives at this │
 * │ panel with is "we expected 1,030 — how many actually landed, and which    │
 * │ file were they from", so every row leads with detected → created/updated  │
 * │ and names both files.                                                     │
 * │                                                                           │
 * │ 'partial' is shown as its own outcome rather than folded into 'failed'.   │
 * │ Each batch is its own transaction, so an import genuinely can stop        │
 * │ halfway with earlier batches committed — and somebody told "failed" would │
 * │ re-run an import that had in fact half succeeded.                         │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * A Server Component: it reads no state and formats dates with the request's
 * locale, which is what getFormatter() is for. Nothing here needs a browser.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export async function ImportHistory({ runs }: { runs: BankImportRun[] }) {
  const t = await getTranslations('import')
  const format = await getFormatter()

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-title-md">{t('history.title')}</h2>
        <p className="text-body-sm text-muted-foreground">{t('history.hint')}</p>
      </div>

      {runs.length === 0 ? (
        <div className="rounded-xl border bg-card">
          <EmptyState icon={HistoryIcon} message={t('history.none')} hint={t('history.noneHint')} />
        </div>
      ) : (
        <ul className="divide-y rounded-xl border bg-card">
          {runs.map((run) => (
            <li key={run.id} className="space-y-2 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 truncate text-body-md">{run.filename}</span>

                <Badge
                  variant={
                    run.status === 'completed'
                      ? 'success'
                      : run.status === 'partial'
                        ? 'warning'
                        : 'destructive'
                  }
                >
                  {t(`history.status.${run.status}`)}
                </Badge>

                <Badge variant="outline">{t(`history.kind.${run.kind}`)}</Badge>
                {run.locale && <Badge variant="outline">{BANK_LOCALE_LABELS[run.locale]}</Badge>}
                <Badge variant="outline">{run.brandName}</Badge>
              </div>

              {run.answerKeyFilename && (
                <p className="text-body-sm text-muted-foreground">
                  <span className="text-label-caps">{t('history.answerKey')}</span>{' '}
                  <span className="break-all">{run.answerKeyFilename}</span>
                </p>
              )}

              <dl className="flex flex-wrap gap-x-5 gap-y-1 text-body-sm">
                <Figure label={t('history.detected')} value={run.detected} />
                <Figure label={t('history.created')} value={run.created} />
                <Figure label={t('history.updated')} value={run.updated} />
                <Figure label={t('history.skipped')} value={run.skipped} />
                <Figure label={t('history.rejected')} value={run.rejected} />
                <Figure label={t('history.warnings')} value={run.warnings} />
              </dl>

              <p className="text-body-sm text-muted-foreground">
                {t('history.by', { name: run.actorName })} ·{' '}
                {format.dateTime(new Date(run.occurredAt), {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                })}
              </p>

              {run.message && (
                <p className="text-body-sm text-muted-foreground">{run.message}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

function Figure({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt className="text-label-caps text-muted-foreground">{label}</dt>
      {/* tabular-nums so a column of runs lines up rather than shuffling as
          digit counts change. */}
      <dd className="tabular-nums">{value}</dd>
    </div>
  )
}
