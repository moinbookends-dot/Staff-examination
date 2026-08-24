'use client'

import { useRef, useState, useTransition } from 'react'
import { useRouter } from '@/lib/i18n/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { DownloadIcon, FileJsonIcon, RotateCcwIcon, UploadIcon } from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { InlineError } from '@/components/ui/inline-error'
import { StatCard } from '@/components/papers/stat-card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { analyseImport, difficultyBalance, isImportable, type ImportReport } from '@/lib/bank/import/analyse'
import { REJECTION_REASONS, topicSlug, type RejectionReason } from '@/lib/bank/import/format'
import { batchRows, toCommitRow, type CommitRow } from '@/lib/bank/import/commit'
import type { BankLocale, Difficulty, QuestionType } from '@/lib/bank/vocabulary'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The import screen.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE FILE IS NEVER UPLOADED. IT IS READ AND CHECKED IN THE BROWSER.        ║
 * ║                                                                           ║
 * ║ Two reasons, and the first is a hard limit rather than a preference:      ║
 * ║                                                                           ║
 * ║  1. A Server Action body is capped at 1 MB by default. 3,000 trilingual   ║
 * ║     questions is several times that, so posting the file to a server      ║
 * ║     action for validation would fail on exactly the dataset this screen   ║
 * ║     exists for — and would fail as a request error, not a report.         ║
 * ║                                                                           ║
 * ║  2. analyse.ts is a pure function with no database and no network. It     ║
 * ║     runs identically here, so the report is instant and a file with a     ║
 * ║     systematic problem is diagnosed without a round trip at all.          ║
 * ║                                                                           ║
 * ║ Only the ACCEPTED rows are sent, in batches, once a person has read the   ║
 * ║ report and pressed the button. Nothing crosses the wire before that.      ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Client-side validation is not a security boundary and is not treated as one:
 * bank_import_commit() re-checks the permission, the brand and the tenancy, and
 * every constraint in 0054 still applies to every row. This is a REPORT, and
 * the database remains the authority.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export type CommitResult =
  | { ok: true; inserted: number; updated: number }
  | { ok: false; message: string }

export interface ImportPanelProps {
  brands: { id: string; name: string; slug: string }[]
  defaultBrandId: string
  /** Topic slugs that exist. An unknown topic is rejected, never created. */
  knownTopics: string[]
  requiredLocales: BankLocale[]
  /** externalIds already in the bank, so the report can say new vs updated. */
  existingExternalIds: string[]
  /**
   * Every question already in this brand's bank, keyed by level + English text.
   *
   * What lets a file adding a language recognise the questions it belongs to.
   * Without it a bank imported without externalIds reads as entirely new on
   * every re-import, and the commit then collides with the text index.
   */
  existingQuestions: { key: string; qtype: QuestionType }[]
  difficultyLabels: Record<Difficulty, string>
  /**
   * Decided on the server from bank.export. Passed as a boolean rather than
   * letting the component read claims — a predicate is a function and cannot
   * cross into a Client Component.
   */
  canExport: boolean
  onCommit: (brandId: string, rows: CommitRow[]) => Promise<CommitResult>
}

export function ImportPanel({
  brands,
  defaultBrandId,
  knownTopics,
  requiredLocales,
  existingExternalIds,
  existingQuestions,
  difficultyLabels,
  canExport,
  onCommit,
}: ImportPanelProps) {
  const t = useTranslations('import')
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const fileInput = useRef<HTMLInputElement>(null)
  /*
   * The brand is URL state, not component state. The report compares the file
   * against ONE brand's bank, and that comparison is made on the server — so a
   * brand changed only here would leave the numbers describing the wrong bank
   * while the commit wrote to the right one.
   */
  const brandId = defaultBrandId

  const chooseBrand = (next: string) => {
    // The report was computed against the old brand; it cannot survive the move.
    reset()
    router.push(`/questions/import?brand=${encodeURIComponent(next)}`)
  }
  const [fileName, setFileName] = useState<string | null>(null)
  const [report, setReport] = useState<ImportReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)

  const readFile = async (file: File) => {
    setError(null)
    setReport(null)
    setProgress(null)
    setFileName(file.name)

    const raw = await file.text()
    setReport(
      analyseImport(raw, {
        knownTopics,
        existingExternalIds,
        existingQuestions,
        requiredLocales,
      }),
    )
  }

  const reset = () => {
    setReport(null)
    setError(null)
    setFileName(null)
    setProgress(null)
    if (fileInput.current) fileInput.current.value = ''
  }

  /*
   * The full report as a file. The analyse layer deliberately keeps EVERY
   * issue for EVERY row ("somebody fixing a generator needs the whole list"),
   * and the screen samples it — so at 1,000 rejections the actionable detail
   * only exists here. Built in the browser from state; nothing touches the
   * server.
   */
  const downloadErrorReport = () => {
    if (!report) return
    const payload = {
      file: fileName,
      totalRows: report.totalRows,
      rejectedCount: report.rejectedCount,
      duplicateCount: report.duplicateCount,
      rejectionsByReason: report.rejectionsByReason,
      rejected: report.rejected.map((r) => ({
        row: r.row,
        externalId: r.externalId ?? null,
        reason: r.reason,
        issues: r.issues,
      })),
      duplicates: report.duplicates,
    }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${(fileName ?? 'import').replace(/.[^.]*$/, '')}-errors.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const commit = () => {
    if (!report) return

    const rows = [...report.toImport, ...report.toUpdate].map(toCommitRow)
    const batches = batchRows(rows)

    setError(null)
    startTransition(async () => {
      let inserted = 0
      let updated = 0

      for (const [index, batch] of batches.entries()) {
        setProgress({ done: index, total: batches.length })

        const result = await onCommit(brandId, batch)

        if (!result.ok) {
          /*
           * A batch is atomic, so this batch wrote nothing — but earlier
           * batches did. Saying so plainly is the whole point: the person is
           * told exactly how far it got and that re-running the same file
           * finishes the job rather than duplicating what landed, which is
           * true because every row carries an externalId.
           */
          setError(
            index === 0
              ? `${t('failed')} ${result.message}`
              : `${t('partial', { done: index, total: batches.length })} ${result.message}`,
          )
          setProgress(null)
          return
        }

        inserted += result.inserted
        updated += result.updated
      }

      setProgress(null)
      toast.success(t('committed', { inserted, updated }))
      reset()
    })
  }

  const importable = report ? isImportable(report) : false
  const commitCount = report ? report.importedCount + report.updatedCount : 0

  /*
   * The file may say which brand it is for — an optional envelope field, and
   * the only thing standing between a Capiche file and the Aiko bank when the
   * dropdown is left on its default. Declared-but-different blocks the commit;
   * a file with no declaration imports exactly as before. Derived, not stored,
   * so switching the dropdown to the right brand clears it without
   * re-analysing. topicSlug() is the normaliser the topic field already uses,
   * so "Capiche" in the file matches the slug `capiche`.
   */
  const selectedBrand = brands.find((brand) => brand.id === brandId)
  const brandMismatch = Boolean(
    report?.declaredBrand &&
      selectedBrand &&
      topicSlug(report.declaredBrand) !== selectedBrand.slug,
  )

  return (
    <div className="space-y-6">
      {error && <InlineError>{error}</InlineError>}

      {/* ── Pick a brand and a file ───────────────────────────────────────── */}
      <div className="space-y-4 rounded-xl border bg-card p-5">
        {/* Only offered when the person may choose. A brand-pinned Editor
            imports into their own brand and is not asked a question with one
            answer. */}
        {brands.length > 1 && (
          <div className="space-y-2">
            <label className="text-label-caps text-muted-foreground" htmlFor="import-brand">
              {t('chooseBrand')}
            </label>
            {/* Base UI hands back `string | null` because a Select can be
                cleared. This one cannot — there is no empty item — so the null
                branch keeps the current brand rather than importing into
                nothing. */}
            <Select
              value={brandId}
              onValueChange={(value) => chooseBrand(value ?? brandId)}
              disabled={pending}
            >
              <SelectTrigger id="import-brand" className="w-full sm:w-80">
                {/*
                  A render function, NOT a bare <SelectValue />.

                  Base UI renders the raw `value` when given no children, and
                  the value here is a brand UUID — so the trigger read
                  "00000000-0000-0000-0000-00000000b001" instead of "Aiko".
                  Caught by screenshotting the page; every HTML assertion
                  passed, because the UUID is genuinely in the markup.
                */}
                <SelectValue>
                  {(value) => brands.find((brand) => brand.id === value)?.name ?? ''}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {brands.map((brand) => (
                  <SelectItem key={brand.id} value={brand.id}>
                    {brand.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}

        <div className="space-y-2">
          <input
            ref={fileInput}
            id="import-file"
            type="file"
            accept=".json,.jsonl,application/json"
            disabled={pending}
            onChange={(e) => {
              const file = e.target.files?.[0]
              if (file) void readFile(file)
            }}
            className="block w-full text-body-sm file:mr-4 file:rounded-md file:border-0 file:bg-primary file:px-4 file:py-2 file:text-body-sm file:font-medium file:text-primary-foreground hover:file:bg-primary/90"
          />
          <p className="text-body-sm text-muted-foreground">{t('fileHint')}</p>
        </div>

        {fileName && (
          <div className="flex items-center gap-2 text-body-sm text-muted-foreground">
            <FileJsonIcon aria-hidden className="size-4 shrink-0" />
            <span className="truncate">{fileName}</span>
          </div>
        )}
      </div>

      {/* ── Export ────────────────────────────────────────────────────────── */}
      {canExport && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-5">
          <div className="min-w-0">
            <h2 className="text-body-md">{t('exportTitle')}</h2>
            <p className="text-body-sm text-muted-foreground">{t('exportHint')}</p>
          </div>

          {/*
            A plain link, not a Server Action. The response is a file with a
            Content-Disposition header, and a Server Action returns a value to
            React rather than a download to the browser. `download` is not set
            because the filename comes from that header, which is where the
            brand name and date are already decided.
          */}
          <a
            href={`/api/bank/export?brand=${encodeURIComponent(brandId)}`}
            className={buttonVariants({ variant: 'outline' })}
          >
            <DownloadIcon />
            {t('exportButton')}
          </a>
        </div>
      )}

      {/* ── The report ────────────────────────────────────────────────────── */}
      {report?.fatal && <InlineError>{report.fatal}</InlineError>}

      {report && !report.fatal && (
        <div className="space-y-6">
          {brandMismatch && report.declaredBrand && (
            <InlineError>
              {t('brandMismatch', {
                declared: report.declaredBrand,
                selected: selectedBrand?.name ?? '',
              })}
            </InlineError>
          )}

          <div>
            <h2 className="text-title-md">{t('reportTitle')}</h2>
            <p className="text-body-sm text-muted-foreground">
              {t('totalRows', { count: report.totalRows })}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard label={t('willImport')} value={report.importedCount} tone="primary" />
            <StatCard label={t('willUpdate')} value={report.updatedCount} />
            <StatCard label={t('willReject')} value={report.rejectedCount} />
            <StatCard label={t('willSkip')} value={report.duplicateCount} />
          </div>

          {/* The split that diagnoses a generator: a file whose short answers
              land and whose MCQs all reject is one systematic fault, and this
              line is where that pattern becomes visible. */}
          <p className="text-body-sm text-muted-foreground tabular-nums">
            {t('mcqSummary', {
              valid: report.countsByType.mcq,
              invalid: report.rejectedByType.mcq,
            })}
            {' · '}
            {t('shortSummary', {
              valid: report.countsByType.short_answer,
              invalid: report.rejectedByType.short_answer,
            })}
          </p>

          {/* Balance by level, because a 3,000-row file that turns out to be
              1,400 Easy and 600 Hard is worth seeing BEFORE it lands rather
              than when a Hard paper cannot be drawn. */}
          {commitCount > 0 && (
            <section className="space-y-3 rounded-xl border bg-card p-5">
              <h3 className="text-label-caps text-muted-foreground">{t('balanceTitle')}</h3>
              {difficultyBalance(report).map(({ difficulty, count, share }) => (
                <div key={difficulty} className="space-y-1">
                  <div className="flex items-baseline justify-between text-body-sm">
                    <span>{difficultyLabels[difficulty]}</span>
                    <span className="text-muted-foreground">{count}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${Math.round(share * 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </section>
          )}

          {/* Grouped by cause, largest first. "412 rows rejected" followed by
              412 sentences is a log; this is the number that drives a fix. */}
          {report.rejectedCount > 0 && (
            <section className="space-y-3 rounded-xl border bg-card p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h3 className="text-label-caps text-muted-foreground">{t('rejectionsTitle')}</h3>
                  <p className="text-body-sm text-muted-foreground">{t('rejectionsHint')}</p>
                </div>
                <Button variant="outline" size="sm" onClick={downloadErrorReport}>
                  <DownloadIcon />
                  {t('downloadErrors')}
                </Button>
              </div>

              <ul className="divide-y">
                {REJECTION_REASONS.filter((r) => report.rejectionsByReason[r] > 0)
                  .sort((a, b) => report.rejectionsByReason[b] - report.rejectionsByReason[a])
                  .map((reason) => (
                    <li key={reason} className="flex items-center justify-between gap-3 py-2">
                      <span className="text-body-sm">{t(`reason.${reason}` as ReasonKey)}</span>
                      <Badge variant="outline">{report.rejectionsByReason[reason]}</Badge>
                    </li>
                  ))}
              </ul>

              {/* A sample rather than the lot — the file download above carries
                  everything — but each sampled row shows its FULL issue list:
                  a row failing three ways diagnosed by its first issue alone
                  sends somebody around the fix-reimport loop three times. */}
              <ul className="space-y-2 border-t pt-3">
                {report.rejected.slice(0, 20).map((row) => (
                  <li key={row.row} className="text-body-sm">
                    <span className="text-label-caps text-muted-foreground">
                      {t('row', { row: row.row })}
                      {row.externalId ? ` · ${row.externalId}` : ''}
                    </span>
                    <ul className="mt-0.5 space-y-0.5 pl-4">
                      {row.issues.map((issue, i) => (
                        <li key={i}>{issue}</li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {report.unknownTopics.length > 0 && (
            <section className="space-y-2 rounded-xl border bg-card p-5">
              <h3 className="text-label-caps text-muted-foreground">{t('unknownTopicsTitle')}</h3>
              <p className="text-body-sm text-muted-foreground">{t('unknownTopicsHint')}</p>
              <div className="flex flex-wrap gap-2 pt-1">
                {report.unknownTopics.map((topic) => (
                  <Badge key={topic} variant="outline">
                    {topic}
                  </Badge>
                ))}
              </div>
            </section>
          )}

          {report.duplicateCount > 0 && (
            <section className="space-y-2 rounded-xl border bg-card p-5">
              <h3 className="text-label-caps text-muted-foreground">{t('duplicatesTitle')}</h3>
              <ul className="space-y-1">
                {report.duplicates.slice(0, 10).map((dup) => (
                  <li key={dup.row} className="text-body-sm text-muted-foreground">
                    {t('duplicatesHint', { row: dup.row, first: dup.firstSeenAtRow })}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {report.missingTranslations.length > 0 && (
            <section className="space-y-2 rounded-xl border bg-card p-5">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-label-caps text-muted-foreground">{t('missingTitle')}</h3>
                {report.downgradedToDraftCount > 0 && (
                  <Badge variant="outline">
                    {t('downgraded')} · {report.downgradedToDraftCount}
                  </Badge>
                )}
              </div>
              <p className="text-body-sm text-muted-foreground">{t('missingHint')}</p>
            </section>
          )}

          {/* ── Commit ──────────────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={commit} disabled={pending || !importable || brandMismatch}>
              <UploadIcon />
              {pending ? t('committing') : t('commit', { count: commitCount })}
            </Button>
            <Button variant="ghost" onClick={reset} disabled={pending}>
              <RotateCcwIcon />
              {t('clear')}
            </Button>

            {progress && (
              <span className="text-body-sm text-muted-foreground" role="status">
                {progress.done} / {progress.total}
              </span>
            )}
          </div>

          {!importable && !report.fatal && (
            <p className="text-body-sm text-muted-foreground">{t('nothingToImport')}</p>
          )}
        </div>
      )}
    </div>
  )
}

/** Keeps the `reason.*` lookup honest against the frozen category list. */
type ReasonKey = `reason.${RejectionReason}`
