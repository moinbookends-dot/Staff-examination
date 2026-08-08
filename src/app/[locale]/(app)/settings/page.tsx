import { getTranslations } from 'next-intl/server'
import { LockIcon } from 'lucide-react'
import { requirePermission } from '@/lib/auth/guards'
import { PageHeader } from '@/components/ui/page-header'
import { Badge } from '@/components/ui/badge'
import { blueprintFor, PAPER_SIZES } from '@/lib/papers/blueprint'
import { BANK_LOCALES, BANK_LOCALE_LABELS, DIFFICULTIES } from '@/lib/bank/vocabulary'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Settings, per the Stitch design.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE 80/20 SPLIT IS PRINTED, NOT EDITED — AND THE STITCH DESIGN OFFERS     ║
 * ║ FIELDS FOR IT.                                                            ║
 * ║                                                                           ║
 * ║ That screen shows "MCQ Count [10]" and "Short Answer Count [5]" as        ║
 * ║ number inputs, with short answers worth 2 marks each. This product does   ║
 * ║ not work that way: every question is worth exactly one mark, so a paper   ║
 * ║ SIZE determines its own split — 20 can only ever be 16 + 4.               ║
 * ║                                                                           ║
 * ║ An input here would have no legal value other than the one already        ║
 * ║ shown. Rendering it as a field would be a control whose every edit is     ║
 * ║ rejected by paper_settings' CHECK constraint, which is a worse experience ║
 * ║ than not offering it.                                                     ║
 * ║                                                                           ║
 * ║ So the numbers are DERIVED by blueprintFor() — the same function the      ║
 * ║ generator uses — and shown with the rule beside them. The visual intent   ║
 * ║ of the design (this is where you understand the paper format) is kept;    ║
 * ║ the editability is not.                                                   ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Everything below is read-only in this pass. The write path needs
 * exam_settings, which arrives with the migrations; the form fields and their
 * validation schema land with the server action rather than as inputs that
 * silently discard what somebody types.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export default async function SettingsPage() {
  await requirePermission('settings.manage')

  const t = await getTranslations('papers')

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title={t('settingsTitle')} description={t('settingsSubtitle')} />

      {/* ── Paper format ─────────────────────────────────────────────────── */}
      <section className="rounded-xl border bg-card p-5">
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-title-md">{t('settingsPaper')}</h2>
          <Badge variant="outline" className="gap-1.5">
            <LockIcon aria-hidden className="size-3" />
            80 / 20
          </Badge>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          {PAPER_SIZES.map((marks) => {
            const blueprint = blueprintFor(marks)
            return (
              <div key={marks} className="rounded-lg border p-4">
                <span className="text-label-caps text-muted-foreground">
                  {t('sizeMarks', { marks })}
                </span>
                <p className="mt-2 text-title-md">
                  {t('sizeBreakdown', {
                    mcq: blueprint.mcqCount,
                    short: blueprint.shortAnswerCount,
                  })}
                </p>
              </div>
            )
          })}
        </div>

        <p className="mt-4 text-body-sm text-muted-foreground">{t('distributionLocked')}</p>

        <dl className="mt-4 border-t pt-4">
          <dt className="text-label-caps text-muted-foreground">{t('passingPercent')}</dt>
          <dd className="mt-1 text-body-md">—</dd>
          <dd className="text-body-sm text-muted-foreground">{t('passingHint')}</dd>
        </dl>
      </section>

      {/* ── Languages ────────────────────────────────────────────────────── */}
      <section className="rounded-xl border bg-card p-5">
        <h2 className="text-title-md">{t('settingsLanguages')}</h2>
        <p className="mt-1 text-body-sm text-muted-foreground">{t('requiredLanguagesHint')}</p>

        <div className="mt-4 flex flex-wrap gap-2">
          {BANK_LOCALES.map((locale) => (
            <Badge
              key={locale}
              // English is the floor: the bank is authored in it and the
              // duplicate-refusal index is scoped to it. hi and gu become
              // required by editing exam_settings.required_locales.
              variant={locale === 'en' ? 'default' : 'outline'}
            >
              {BANK_LOCALE_LABELS[locale]}
            </Badge>
          ))}
        </div>
      </section>

      {/* ── Difficulty labels ────────────────────────────────────────────── */}
      <section className="rounded-xl border bg-card p-5">
        <h2 className="text-title-md">{t('settingsDifficulty')}</h2>
        <p className="mt-1 text-body-sm text-muted-foreground">{t('labelsHint')}</p>

        <dl className="mt-4 grid gap-3 sm:grid-cols-3">
          {DIFFICULTIES.map((d) => (
            <div key={d} className="rounded-lg border p-4">
              {/* The enum value in mono, the label beneath it. The point of the
                  hint above is that the left-hand side never changes, so it is
                  shown rather than described. */}
              <dt className="text-label-caps text-muted-foreground">{d}</dt>
              <dd className="mt-1 text-body-md">{t(`difficulty.${d}`)}</dd>
            </div>
          ))}
        </dl>
      </section>

      {/* ── PDF ──────────────────────────────────────────────────────────── */}
      <section className="rounded-xl border bg-card p-5">
        <h2 className="text-title-md">{t('settingsPdf')}</h2>

        <dl className="mt-4 grid gap-4 sm:grid-cols-2">
          <div>
            <dt className="text-label-caps text-muted-foreground">{t('pdfHeader')}</dt>
            <dd className="mt-1 text-body-md">—</dd>
            <dd className="text-body-sm text-muted-foreground">{t('pdfHeaderHint')}</dd>
          </div>
          <div>
            <dt className="text-label-caps text-muted-foreground">{t('pdfFooter')}</dt>
            <dd className="mt-1 text-body-md">—</dd>
          </div>
          <div>
            <dt className="text-label-caps text-muted-foreground">{t('pdfLogo')}</dt>
            <dd className="mt-1 text-body-md">—</dd>
          </div>
          <div>
            <dt className="text-label-caps text-muted-foreground">{t('pdfWatermark')}</dt>
            <dd className="mt-1 text-body-md">—</dd>
            <dd className="text-body-sm text-muted-foreground">{t('pdfWatermarkHint')}</dd>
          </div>
        </dl>
      </section>
    </div>
  )
}
