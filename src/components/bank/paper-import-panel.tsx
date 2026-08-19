'use client'

import { useCallback, useMemo, useRef, useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import {
  CheckCircle2Icon,
  FileTextIcon,
  KeyRoundIcon,
  RotateCcwIcon,
  UploadIcon,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { InlineError } from '@/components/ui/inline-error'
import { StatCard } from '@/components/papers/stat-card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { PaperPreview } from '@/components/bank/paper-preview'
import { TopicMapper } from '@/components/bank/topic-mapper'
import { ACCEPTED_EXTENSIONS, detectFormat, parseAnswerKey, parsePaper } from '@/lib/bank/paper/detect'
import { analysePaper, isPaperImportable } from '@/lib/bank/paper/validate'
import { PAPER_IMPORT_BATCH_SIZE, paperBatches, paperCommitRows } from '@/lib/bank/paper/commit'
import type {
  BankFact,
  DuplicateMode,
  PaperFormat,
  ParsedAnswerKey,
  ParsedPaper,
  PreparedField,
  QuestionEdits,
} from '@/lib/bank/paper/types'
import {
  BANK_LOCALES,
  BANK_LOCALE_LABELS,
  DIFFICULTIES,
  type BankLocale,
  type Difficulty,
} from '@/lib/bank/vocabulary'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Paper Import — a printed question paper and its answer key, read in the
 * browser and matched against the bank before a single row is written.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE FILE IS NEVER UPLOADED. IT IS READ AND CHECKED HERE.                  ║
 * ║                                                                           ║
 * ║ Not a preference — a hard limit. A Server Action body is capped at 1 MB,  ║
 * ║ and the document this screen was built for is 1.0 MB with a 586 KB answer ║
 * ║ key. Posting either to a server action would fail as a REQUEST ERROR on   ║
 * ║ exactly the file the feature exists for, and the person would see a       ║
 * ║ network failure rather than a report.                                     ║
 * ║                                                                           ║
 * ║ Everything under src/lib/bank/paper/ is pure, so it runs identically in   ║
 * ║ this browser and in vitest — where it is pinned against all 1,030 real    ║
 * ║ questions. Only the REVIEWED rows cross the wire, in batches, after       ║
 * ║ somebody has pressed the button.                                          ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHAT ARRIVES HERE IS ONE LANGUAGE. THE SERVER ADDS THE OTHERS.            │
 * │                                                                           │
 * │ bank_import_commit() deletes any language absent from its payload — on    │
 * │ purpose, so a bad translation can be retracted. Sending a merged row from │
 * │ a browser would mean the browser holding every existing translation, and  │
 * │ getting that wrong once already destroyed 1,023 Hindi rows. The wire      │
 * │ shape here CANNOT express the other languages; the merge happens in       │
 * │ src/server/actions/paper-import.ts, against the bank.                     │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Client-side validation is not a security boundary and is not treated as one.
 * commitPaperImport() re-checks the permission, re-validates the shape, re-reads
 * every field except the text from the bank, and RLS authorises every write.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export type PaperCommitOutcome =
  | { ok: true; inserted: number; updated: number }
  | { ok: false; message: string; technical?: string }

interface PickedFile {
  name: string
  size: number
  text: string
  format: PaperFormat
}

export interface PaperImportPanelProps {
  brands: { id: string; name: string }[]
  defaultBrandId: string
  topics: { name: string; slug: string }[]
  difficultyLabels: Record<Difficulty, string>
  canCreateTopics: boolean
  onResolve: (brandId: string, externalIds: string[]) => Promise<
    { ok: true; facts: BankFact[] } | { ok: false; message: string }
  >
  onCommit: (input: {
    brandId: string
    locale: BankLocale
    rows: ReturnType<typeof paperCommitRows>
  }) => Promise<PaperCommitOutcome>
  onCreateTopic: (
    name: string,
  ) => Promise<{ ok: true; slug: string } | { ok: false; message: string }>
  onRecordRun: (input: {
    brandId: string
    kind: 'paper'
    locale: BankLocale
    filename: string
    answerKeyFilename: string | null
    detected: number
    created: number
    updated: number
    skipped: number
    rejected: number
    warnings: number
    status: 'completed' | 'partial' | 'failed'
    message: string | null
  }) => Promise<{ recorded: boolean }>
}

export function PaperImportPanel({
  brands,
  defaultBrandId,
  topics,
  difficultyLabels,
  canCreateTopics,
  onResolve,
  onCommit,
  onCreateTopic,
  onRecordRun,
}: PaperImportPanelProps) {
  const t = useTranslations('import')
  const [pending, startTransition] = useTransition()

  const paperInput = useRef<HTMLInputElement>(null)
  const keyInput = useRef<HTMLInputElement>(null)

  const [brandId, setBrandId] = useState(defaultBrandId)
  const [locale, setLocale] = useState<BankLocale>('hi')
  const [duplicateMode, setDuplicateMode] = useState<DuplicateMode>('update')
  const [createUnmatched, setCreateUnmatched] = useState(false)
  const [createDifficulty, setCreateDifficulty] = useState<Difficulty>('hard')

  const [paperFile, setPaperFile] = useState<PickedFile | null>(null)
  const [keyFile, setKeyFile] = useState<PickedFile | null>(null)
  const [parsedPaper, setParsedPaper] = useState<ParsedPaper | null>(null)
  const [parsedKey, setParsedKey] = useState<ParsedAnswerKey | null>(null)

  const [facts, setFacts] = useState<BankFact[] | undefined>(undefined)
  const [edits, setEdits] = useState<QuestionEdits>({})
  const [headingTopics, setHeadingTopics] = useState<Record<string, string>>({})

  const [error, setError] = useState<string | null>(null)
  const [technical, setTechnical] = useState<string | null>(null)
  const [analysing, setAnalysing] = useState(false)
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null)
  /** The batch a failed run stopped at, so it can be resumed rather than redone. */
  const [resumeFrom, setResumeFrom] = useState<number | null>(null)
  const [done, setDone] = useState<{ inserted: number; updated: number } | null>(null)

  // ── The report, recomputed on every edit ──────────────────────────────────
  const report = useMemo(() => {
    if (!parsedPaper) return null
    return analysePaper(parsedPaper, parsedKey, {
      locale,
      facts,
      duplicateMode,
      createUnmatched,
      createDifficulty: createUnmatched ? createDifficulty : null,
      headingTopics,
      knownTopics: topics.map((topic) => topic.slug),
      edits,
    })
  }, [
    parsedPaper,
    parsedKey,
    locale,
    facts,
    duplicateMode,
    createUnmatched,
    createDifficulty,
    headingTopics,
    topics,
    edits,
  ])

  const importable = report ? isPaperImportable(report) : false

  // ── Picking files ─────────────────────────────────────────────────────────
  const choose = useCallback(
    async (file: File, role: 'paper' | 'answer-key') => {
      setError(null)
      setTechnical(null)
      setDone(null)
      setResumeFrom(null)

      const text = await file.text()
      const verdict = detectFormat(file.name, text)

      if ('fatal' in verdict) {
        setError(verdict.fatal)
        if (role === 'paper') {
          setPaperFile(null)
          setParsedPaper(null)
          setFacts(undefined)
        } else {
          setKeyFile(null)
          setParsedKey(null)
        }
        return
      }

      /*
       * A gentle warning rather than a refusal. The two slots already say which
       * file is which, so the only thing worth saying is "this one looks like
       * the other half" — which is the mistake somebody actually makes when
       * both files sit in one folder with near-identical names.
       */
      if (verdict.role && verdict.role !== role) {
        toast.warning(t(role === 'paper' ? 'paper.looksLikeKey' : 'paper.looksLikePaper'))
      }

      const picked: PickedFile = { name: file.name, size: file.size, text, format: verdict.format }

      if (role === 'paper') {
        setPaperFile(picked)
        setParsedPaper(null)
        setFacts(undefined)
        setEdits({})
      } else {
        setKeyFile(picked)
        setParsedKey(null)
      }
    },
    [t],
  )

  /**
   * Parse the paper, then ask the bank what it already holds for the ids it
   * named. One button, because a parsed paper with no bank facts cannot say
   * anything useful — not new-vs-existing, and not whether a single answer
   * letter agrees.
   */
  const analysePaperFile = () => {
    if (!paperFile) return
    setError(null)
    setTechnical(null)
    setAnalysing(true)

    const parsed = parsePaper(paperFile.format, paperFile.text)
    setParsedPaper(parsed)
    setEdits({})

    if (parsed.fatal) {
      setAnalysing(false)
      setFacts(undefined)
      return
    }

    const ids = [...new Set(parsed.questions.map((q) => q.externalId).filter((id): id is string => Boolean(id)))]


    if (ids.length === 0) {
      setAnalysing(false)
      setFacts([])
      return
    }

    startTransition(async () => {
      const result = await onResolve(brandId, ids)
      setAnalysing(false)
      if (!result.ok) {
        setError(result.message)
        setFacts(undefined)
        return
      }
      setFacts(result.facts)
    })
  }

  const analyseKeyFile = () => {
    if (!keyFile) return
    setError(null)
    setParsedKey(parseAnswerKey(keyFile.format, keyFile.text))
  }

  const reset = () => {
    setPaperFile(null)
    setKeyFile(null)
    setParsedPaper(null)
    setParsedKey(null)
    setFacts(undefined)
    setEdits({})
    setHeadingTopics({})
    setError(null)
    setTechnical(null)
    setProgress(null)
    setResumeFrom(null)
    setDone(null)
    if (paperInput.current) paperInput.current.value = ''
    if (keyInput.current) keyInput.current.value = ''
  }

  // ── Editing ───────────────────────────────────────────────────────────────
  const edit = useCallback((key: string, field: PreparedField, value: string) => {
    setEdits((previous) => ({ ...previous, [key]: { ...previous[key], [field]: value } }))
  }, [])

  const revert = useCallback((key: string) => {
    setEdits((previous) => {
      const next = { ...previous }
      delete next[key]
      return next
    })
  }, [])

  // ── Importing ─────────────────────────────────────────────────────────────
  const runImport = (from = 0) => {
    if (!report || !paperFile) return

    const rows = paperCommitRows(report)
    const batches = paperBatches(rows)

    setError(null)
    setTechnical(null)
    setDone(null)

    startTransition(async () => {
      let inserted = 0
      let updated = 0

      for (let index = from; index < batches.length; index += 1) {
        setProgress({ done: index, total: batches.length })
        const result = await onCommit({ brandId, locale, rows: batches[index] })

        if (!result.ok) {
          /*
           * This batch is a transaction, so it wrote nothing — but the batches
           * before it did. Saying exactly how far it got is the whole point:
           * the person can resume from here rather than re-running everything,
           * and re-running would be safe anyway because every row is keyed by
           * its externalId and re-application is an update.
           */
          setError(
            index === from
              ? result.message
              : `${t('paper.stoppedAt', { done: index, total: batches.length })} ${result.message}`,
          )
          setTechnical(result.technical ?? null)
          setResumeFrom(index)
          setProgress(null)

          await onRecordRun({
            brandId,
            kind: 'paper',
            locale,
            filename: paperFile.name,
            answerKeyFilename: keyFile?.name ?? null,
            detected: report.detected,
            created: inserted,
            updated,
            skipped: report.skipCount,
            rejected: report.rejectedCount,
            warnings: report.warningCount,
            status: index === from && from === 0 ? 'failed' : 'partial',
            message: result.message.slice(0, 2000),
          })
          return
        }

        inserted += result.inserted
        updated += result.updated
      }

      setProgress(null)
      setResumeFrom(null)
      setDone({ inserted, updated })

      await onRecordRun({
        brandId,
        kind: 'paper',
        locale,
        filename: paperFile.name,
        answerKeyFilename: keyFile?.name ?? null,
        detected: report.detected,
        created: inserted,
        updated,
        skipped: report.skipCount,
        rejected: report.rejectedCount,
        warnings: report.warningCount,
        status: 'completed',
        message: null,
      })

      toast.success(t('paper.imported', { inserted, updated }))
    })
  }

  const busy = pending || analysing
  const unmappedHeadings = report
    ? report.questions
        .filter((question) => question.action === 'create' && question.heading)
        .map((question) => question.heading!)
        .filter((heading, i, all) => all.indexOf(heading) === i)
    : []

  return (
    <div className="space-y-6">
      {error && (
        <div className="space-y-2">
          <InlineError>{error}</InlineError>
          {technical && (
            <details className="rounded-lg border bg-card p-3">
              <summary className="cursor-pointer text-body-sm text-muted-foreground">
                {t('technicalDetails')}
              </summary>
              <code className="mt-2 block font-mono text-xs break-all text-muted-foreground">
                {technical}
              </code>
            </details>
          )}
          {resumeFrom !== null && (
            <Button variant="outline" onClick={() => runImport(resumeFrom)} disabled={busy}>
              <UploadIcon />
              {t('paper.retry', { batch: resumeFrom + 1 })}
            </Button>
          )}
        </div>
      )}

      {/* ── Where it goes ──────────────────────────────────────────────────── */}
      <section className="grid gap-4 rounded-xl border bg-card p-5 sm:grid-cols-2">
        {brands.length > 1 && (
          <div className="space-y-2">
            <Label htmlFor="paper-brand" className="text-label-caps text-muted-foreground">
              {t('chooseBrand')}
            </Label>
            <Select
              value={brandId}
              onValueChange={(value) => {
                setBrandId(value ?? brandId)
                // The bank facts were fetched for the OLD brand and every
                // answer-letter check is made against them. Dropping them
                // forces a re-analysis rather than reporting one brand's
                // questions against another brand's answers.
                setFacts(undefined)
              }}
              disabled={busy}
            >
              <SelectTrigger id="paper-brand" className="w-full">
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
          <Label htmlFor="paper-locale" className="text-label-caps text-muted-foreground">
            {t('paper.language')}
          </Label>
          <Select
            value={locale}
            onValueChange={(value) => setLocale((value as BankLocale) ?? locale)}
            disabled={busy}
          >
            <SelectTrigger id="paper-locale" className="w-full">
              <SelectValue>{(value) => BANK_LOCALE_LABELS[value as BankLocale]}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {BANK_LOCALES.map((code) => (
                <SelectItem key={code} value={code}>
                  {BANK_LOCALE_LABELS[code]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-body-sm text-muted-foreground">{t('paper.languageHint')}</p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="paper-duplicates" className="text-label-caps text-muted-foreground">
            {t('paper.duplicates')}
          </Label>
          <Select
            value={duplicateMode}
            onValueChange={(value) => setDuplicateMode((value as DuplicateMode) ?? 'update')}
            disabled={busy}
          >
            <SelectTrigger id="paper-duplicates" className="w-full">
              <SelectValue>{(value) => t(`paper.mode.${value as DuplicateMode}`)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="update">{t('paper.mode.update')}</SelectItem>
              <SelectItem value="skip">{t('paper.mode.skip')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {/* Creating questions is only possible in English, because a question
            with no English text cannot exist — so the control is not offered in
            a language where it could not work. */}
        {locale === 'en' && (
          <div className="space-y-2">
            <Label htmlFor="paper-create" className="text-label-caps text-muted-foreground">
              {t('paper.unmatched')}
            </Label>
            <Select
              value={createUnmatched ? 'create' : 'reject'}
              onValueChange={(value) => setCreateUnmatched(value === 'create')}
              disabled={busy}
            >
              <SelectTrigger id="paper-create" className="w-full">
                <SelectValue>
                  {(value) => t(`paper.unmatchedMode.${value as 'create' | 'reject'}`)}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="reject">{t('paper.unmatchedMode.reject')}</SelectItem>
                <SelectItem value="create">{t('paper.unmatchedMode.create')}</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}

        {locale === 'en' && createUnmatched && (
          <div className="space-y-2">
            <Label htmlFor="paper-difficulty" className="text-label-caps text-muted-foreground">
              {t('paper.newLevel')}
            </Label>
            <Select
              value={createDifficulty}
              onValueChange={(value) => setCreateDifficulty((value as Difficulty) ?? createDifficulty)}
              disabled={busy}
            >
              <SelectTrigger id="paper-difficulty" className="w-full">
                <SelectValue>{(value) => difficultyLabels[value as Difficulty]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {DIFFICULTIES.map((difficulty) => (
                  <SelectItem key={difficulty} value={difficulty}>
                    {difficultyLabels[difficulty]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        )}
      </section>

      {/* ── The two files ──────────────────────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-2">
        <FileSlot
          id="paper-file"
          inputRef={paperInput}
          icon={<FileTextIcon aria-hidden className="size-5 text-muted-foreground" />}
          title={t('paper.paperTitle')}
          hint={t('paper.paperHint')}
          file={paperFile}
          disabled={busy}
          onChoose={(file) => void choose(file, 'paper')}
          action={
            <Button onClick={analysePaperFile} disabled={!paperFile || busy}>
              {analysing ? t('paper.analysing') : t('paper.analysePaper')}
            </Button>
          }
          status={
            parsedPaper && !parsedPaper.fatal
              ? t('paper.detectedQuestions', { count: parsedPaper.questions.length })
              : null
          }
          fatal={parsedPaper?.fatal ?? null}
        />

        <FileSlot
          id="key-file"
          inputRef={keyInput}
          icon={<KeyRoundIcon aria-hidden className="size-5 text-muted-foreground" />}
          title={t('paper.keyTitle')}
          hint={t('paper.keyHint')}
          file={keyFile}
          disabled={busy}
          onChoose={(file) => void choose(file, 'answer-key')}
          action={
            <Button variant="outline" onClick={analyseKeyFile} disabled={!keyFile || busy}>
              {t('paper.analyseKey')}
            </Button>
          }
          status={
            parsedKey && !parsedKey.fatal
              ? t('paper.detectedAnswers', { count: parsedKey.entries.length })
              : null
          }
          fatal={parsedKey?.fatal ?? null}
        />
      </div>

      {report?.fatal && <InlineError>{report.fatal}</InlineError>}

      {/* ── The report ─────────────────────────────────────────────────────── */}
      {report && !report.fatal && (
        <div className="space-y-6">
          <div>
            <h2 className="text-title-md">{t('paper.reportTitle')}</h2>
            <p className="text-body-sm text-muted-foreground tabular-nums">
              {t('paper.reportSubtitle', {
                detected: report.detected,
                answers: report.keyEntries,
                matched: report.matched,
              })}
            </p>
          </div>

          <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
            <StatCard label={t('paper.willCreate')} value={report.createCount} tone="primary" />
            <StatCard label={t('paper.willUpdate')} value={report.updateCount} tone="primary" />
            <StatCard label={t('paper.willSkip')} value={report.skipCount} />
            <StatCard label={t('paper.rejected')} value={report.rejectedCount} />
          </div>

          <div className="grid grid-cols-3 gap-4">
            <StatCard label={t('paper.valid')} value={report.validCount} />
            <StatCard label={t('paper.warnings')} value={report.warningCount} />
            <StatCard label={t('paper.errors')} value={report.errorCount} />
          </div>

          {/*
            Shown for the WHOLE time the bank is unknown, including while the
            lookup is in flight. It used to be hidden during the lookup, so for
            the second and a half it takes over a thousand ids the screen
            rendered a confident report of a state it had not established yet.
          */}
          {facts === undefined && (
            <InlineError>{analysing ? t('paper.checkingBank') : t('paper.notResolved')}</InlineError>
          )}

          <Aggregates report={report} />

          {createUnmatched && unmappedHeadings.length > 0 && (
            <TopicMapper
              headings={unmappedHeadings}
              topics={topics}
              value={headingTopics}
              onChange={(heading, slug) =>
                setHeadingTopics((previous) => ({ ...previous, [heading]: slug }))
              }
              disabled={busy}
              canCreateTopics={canCreateTopics}
              onCreateTopic={onCreateTopic}
            />
          )}

          <PaperPreview
            report={report}
            topics={topics}
            difficultyLabels={difficultyLabels}
            disabled={busy}
            onEdit={edit}
            onResetEdits={revert}
          />

          {/* ── Import ──────────────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-5">
            {importable ? (
              <p className="flex items-center gap-2 text-body-sm text-success">
                <CheckCircle2Icon aria-hidden className="size-4 shrink-0" />
                {t('paper.ready', { count: report.createCount + report.updateCount })}
              </p>
            ) : (
              <p className="text-body-sm text-muted-foreground">
                {report.blockingCount > 0
                  ? t('paper.blocked', { count: report.blockingCount })
                  : t('paper.nothingToImport')}
              </p>
            )}

            <div className="ml-auto flex flex-wrap items-center gap-3">
              {progress && (
                <span className="text-body-sm text-muted-foreground tabular-nums" role="status">
                  {t('paper.progress', {
                    done: progress.done,
                    total: progress.total,
                    size: PAPER_IMPORT_BATCH_SIZE,
                  })}
                </span>
              )}

              <Button onClick={() => runImport(0)} disabled={busy || !importable}>
                <UploadIcon />
                {pending ? t('paper.importing') : t('paper.import')}
              </Button>
              <Button variant="ghost" onClick={reset} disabled={busy}>
                <RotateCcwIcon />
                {t('clear')}
              </Button>
            </div>
          </div>

          {done && (
            <p
              role="status"
              className="flex items-center gap-2 rounded-xl border border-success/40 bg-success/8 p-4 text-body-sm text-success"
            >
              <CheckCircle2Icon aria-hidden className="size-4 shrink-0" />
              {t('paper.imported', { inserted: done.inserted, updated: done.updated })}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// One file slot
// ─────────────────────────────────────────────────────────────────────────────

function FileSlot({
  id,
  inputRef,
  icon,
  title,
  hint,
  file,
  disabled,
  onChoose,
  action,
  status,
  fatal,
}: {
  id: string
  inputRef: React.RefObject<HTMLInputElement | null>
  icon: React.ReactNode
  title: string
  hint: string
  file: PickedFile | null
  disabled: boolean
  onChoose: (file: File) => void
  action: React.ReactNode
  status: string | null
  fatal: string | null
}) {
  const t = useTranslations('import')
  const [over, setOver] = useState(false)

  return (
    <section
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        const dropped = e.dataTransfer.files?.[0]
        if (dropped && !disabled) onChoose(dropped)
      }}
      className={
        over
          ? 'space-y-3 rounded-xl border-2 border-dashed border-primary bg-primary/5 p-5'
          : 'space-y-3 rounded-xl border-2 border-dashed bg-card p-5'
      }
    >
      <div className="flex items-center gap-2">
        {icon}
        <h3 className="text-body-md">{title}</h3>
      </div>
      <p className="text-body-sm text-muted-foreground">{hint}</p>

      <div className="space-y-2">
        <Label htmlFor={id} className="sr-only">
          {title}
        </Label>
        <input
          ref={inputRef}
          id={id}
          type="file"
          // .pdf is deliberately absent — detectFormat() refuses it with a
          // sentence if somebody drags one in anyway.
          accept={ACCEPTED_EXTENSIONS.join(',')}
          disabled={disabled}
          onChange={(e) => {
            const chosen = e.target.files?.[0]
            if (chosen) onChoose(chosen)
          }}
          className="block w-full text-body-sm file:mr-4 file:rounded-md file:border-0 file:bg-primary file:px-4 file:py-2 file:text-body-sm file:font-medium file:text-primary-foreground hover:file:bg-primary/90"
        />
        <p className="text-body-sm text-muted-foreground">{t('paper.dropHint')}</p>
      </div>

      {file && (
        <dl className="space-y-1 text-body-sm">
          <div className="flex gap-2">
            <dt className="text-label-caps text-muted-foreground">{t('paper.file')}</dt>
            <dd className="min-w-0 truncate">{file.name}</dd>
          </div>
          <div className="flex gap-2">
            <dt className="text-label-caps text-muted-foreground">{t('paper.size')}</dt>
            <dd className="tabular-nums">{formatSize(file.size)}</dd>
          </div>
        </dl>
      )}

      <div className="flex flex-wrap items-center gap-3">
        {action}
        {status && <Badge variant="success">{status}</Badge>}
      </div>

      {fatal && <InlineError>{fatal}</InlineError>}
    </section>
  )
}

/**
 * The things worth saying about the whole document rather than one question.
 *
 * Each is a list of ids or numbers, not a count, because "4 duplicate numbers"
 * cannot be acted on and "42, 43, 900, 901" can. Capped, so a systematically
 * broken document produces a report rather than a wall.
 */
function Aggregates({ report }: { report: ReturnType<typeof analysePaper> }) {
  const t = useTranslations('import')

  const rows: { label: string; values: (string | number)[] }[] = [
    { label: t('paper.duplicateIds'), values: report.duplicateIds },
    { label: t('paper.duplicateNumbers'), values: report.duplicateNumbers },
    { label: t('paper.missingNumbers'), values: report.missingNumbers },
    { label: t('paper.extraKeyIds'), values: report.extraKeyIds },
  ].filter((row) => row.values.length > 0)

  if (rows.length === 0 && report.keyProblems.length === 0) return null

  return (
    <section className="space-y-3 rounded-xl border bg-card p-5">
      <h3 className="text-label-caps text-muted-foreground">{t('paper.wholeDocument')}</h3>

      {/* A malformed answer grid belongs to no single question, so without this
          it would have nowhere to appear — and a grid one cell short shifts
          every answer after it, which is the failure nobody can see by eye. */}
      {report.keyProblems.map((problem) => (
        <InlineError key={problem}>{problem}</InlineError>
      ))}

      <ul className="space-y-2">
        {rows.map((row) => (
          <li key={row.label} className="text-body-sm">
            <span className="text-label-caps text-muted-foreground">{row.label}</span>{' '}
            <span className="tabular-nums">
              {row.values.slice(0, 25).join(', ')}
              {row.values.length > 25 && ` … +${row.values.length - 25}`}
            </span>
          </li>
        ))}
      </ul>
    </section>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
