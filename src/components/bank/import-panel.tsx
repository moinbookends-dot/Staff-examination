'use client'

import { useRef, useState, useTransition } from 'react'
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
import { REJECTION_REASONS, type RejectionReason } from '@/lib/bank/import/format'
import { batchRows, toCommitRow, type CommitRow } from '@/lib/bank/import/commit'
import type { BankLocale, Difficulty } from '@/lib/bank/vocabulary'

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
  brands: { id: string; name: string }[]
  defaultBrandId: string
  /** Topic slugs that exist. An unknown topic is rejected, never created. */
  knownTopics: string[]
  requiredLocales: BankLocale[]
  /** externalIds already in the bank, so the report can say new vs updated. */
  existingExternalIds: string[]
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
  difficultyLabels,
  canExport,
  onCommit,
}: ImportPanelProps) {
  const t = useTranslations('import')
  const [pending, startTransition] = useTransition()

  const fileInput = useRef<HTMLInputElement>(null)
  const [brandId, setBrandId] = useState(defaultBrandId)
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
              onValueChange={(value) => setBrandId(value ?? brandId)}
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
              <div>
                <h3 className="text-label-caps text-muted-foreground">{t('rejectionsTitle')}</h3>
                <p className="text-body-sm text-muted-foreground">{t('rejectionsHint')}</p>
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

              {/* A sample rather than the lot: at 3,000 rows the categories are
                  the actionable part, and the first few examples are enough to
                  recognise the pattern. */}
              <ul className="space-y-2 border-t pt-3">
                {report.rejected.slice(0, 10).map((row) => (
                  <li key={row.row} className="text-body-sm">
                    <span className="text-label-caps text-muted-foreground">
                      {t('row', { row: row.row })}
                    </span>{' '}
                    {row.issues[0]}
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
            <Button onClick={commit} disabled={pending || !importable}>
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
