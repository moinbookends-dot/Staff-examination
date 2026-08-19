'use client'

import { useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import {
  AlertTriangleIcon,
  CheckIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PencilIcon,
  RotateCcwIcon,
  SearchIcon,
  XIcon,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { EmptyState } from '@/components/ui/empty-state'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { DIFFICULTIES, OPTION_KEYS, QUESTION_TYPES, type Difficulty, type OptionKey } from '@/lib/bank/vocabulary'
import type { Finding, PaperReport, PreparedField, PreparedQuestion } from '@/lib/bank/paper/types'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The preview: every detected question, before anything is written.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ PAGINATED, AND THAT IS A CORRECTNESS DECISION RATHER THAN A NICETY.       ║
 * ║                                                                           ║
 * ║ The document this screen exists for holds 1,030 questions with four       ║
 * ║ options each — over five thousand editable fields. Rendering them at once ║
 * ║ produces a page that takes seconds to paint, janks on every keystroke,    ║
 * ║ and on a mid-range laptop can simply run out of memory.                   ║
 * ║                                                                           ║
 * ║ A person who cannot scroll the preview does not read it, and a preview    ║
 * ║ nobody reads is the same as no preview at all — which is the one thing    ║
 * ║ this whole feature exists to prevent.                                     ║
 * ║                                                                           ║
 * ║ THE COUNTS ABOVE ARE ALWAYS OF THE WHOLE SET, never of the visible page.  ║
 * ║ Filtering changes what is shown and never what is reported.               ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Edits are held by the PANEL, not here, and re-validated on every change —
 * so a question fixed in the preview stops being an error immediately and the
 * Import button can enable itself without anybody pressing "re-check".
 * ═══════════════════════════════════════════════════════════════════════════
 */

const PAGE_SIZE = 25

type Filter = 'all' | 'errors' | 'warnings' | 'valid' | 'edited'

export interface PaperPreviewProps {
  report: PaperReport
  topics: { name: string; slug: string }[]
  difficultyLabels: Record<Difficulty, string>
  disabled: boolean
  onEdit: (key: string, field: PreparedField, value: string) => void
  onResetEdits: (key: string) => void
}

export function PaperPreview({
  report,
  topics,
  difficultyLabels,
  disabled,
  onEdit,
  onResetEdits,
}: PaperPreviewProps) {
  const t = useTranslations('import')

  const [search, setSearch] = useState('')
  const [numberFilter, setNumberFilter] = useState('')
  const [filter, setFilter] = useState<Filter>('all')
  const [page, setPage] = useState(1)
  const [editing, setEditing] = useState<string | null>(null)

  const range = useMemo(() => parseRange(numberFilter), [numberFilter])

  const matches = useMemo(() => {
    const needle = search.trim().toLowerCase()

    return report.questions.filter((question) => {
      if (filter === 'errors' && question.errors.length === 0) return false
      if (filter === 'warnings' && question.warnings.length === 0) return false
      if (filter === 'valid' && (question.errors.length > 0 || question.warnings.length > 0)) {
        return false
      }
      if (filter === 'edited' && !question.edited) return false

      if (range && question.number !== null) {
        if (question.number < range.from || question.number > range.to) return false
      } else if (range && question.number === null) {
        return false
      }

      if (!needle) return true
      return (
        question.externalId.toLowerCase().includes(needle) ||
        question.stem.toLowerCase().includes(needle) ||
        [question.optionA, question.optionB, question.optionC, question.optionD, question.answerText]
          .filter(Boolean)
          .some((text) => text!.toLowerCase().includes(needle))
      )
    })
  }, [report.questions, search, filter, range])

  const pages = Math.max(1, Math.ceil(matches.length / PAGE_SIZE))
  const current = Math.min(page, pages)
  const visible = matches.slice((current - 1) * PAGE_SIZE, current * PAGE_SIZE)

  const reset = (next: () => void) => {
    next()
    setPage(1)
  }

  return (
    <section className="space-y-4">
      {/* ── Filters ─────────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-end gap-3 rounded-xl border bg-card p-4">
        <div className="min-w-48 flex-1 space-y-1.5">
          <Label htmlFor="preview-search" className="text-label-caps text-muted-foreground">
            {t('preview.search')}
          </Label>
          <div className="relative">
            <SearchIcon
              aria-hidden
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
            />
            <Input
              id="preview-search"
              value={search}
              placeholder={t('preview.searchHint')}
              onChange={(e) => reset(() => setSearch(e.target.value))}
              className="pl-8"
            />
          </div>
        </div>

        <div className="w-36 space-y-1.5">
          <Label htmlFor="preview-number" className="text-label-caps text-muted-foreground">
            {t('preview.numbers')}
          </Label>
          <Input
            id="preview-number"
            value={numberFilter}
            placeholder="42 or 40-60"
            inputMode="numeric"
            onChange={(e) => reset(() => setNumberFilter(e.target.value))}
          />
        </div>

        <div className="w-48 space-y-1.5">
          <Label htmlFor="preview-filter" className="text-label-caps text-muted-foreground">
            {t('preview.show')}
          </Label>
          <Select
            value={filter}
            onValueChange={(value) => reset(() => setFilter((value as Filter) ?? 'all'))}
          >
            <SelectTrigger id="preview-filter" className="w-full">
              <SelectValue>{(value) => t(`preview.filter.${value as Filter}`)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{t('preview.filter.all')}</SelectItem>
              <SelectItem value="errors">{t('preview.filter.errors')}</SelectItem>
              <SelectItem value="warnings">{t('preview.filter.warnings')}</SelectItem>
              <SelectItem value="valid">{t('preview.filter.valid')}</SelectItem>
              <SelectItem value="edited">{t('preview.filter.edited')}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <p className="pb-1.5 text-body-sm text-muted-foreground tabular-nums" role="status">
          {t('preview.matching', { shown: matches.length, total: report.questions.length })}
        </p>
      </div>

      {/* ── The questions ───────────────────────────────────────────────────── */}
      {visible.length === 0 ? (
        <div className="rounded-xl border bg-card">
          <EmptyState icon={SearchIcon} message={t('preview.none')} hint={t('preview.noneHint')} />
        </div>
      ) : (
        <ul className="space-y-3">
          {visible.map((question) => (
            <li key={question.key}>
              <QuestionCard
                question={question}
                topics={topics}
                difficultyLabels={difficultyLabels}
                disabled={disabled}
                open={editing === question.key}
                onToggle={() => setEditing(editing === question.key ? null : question.key)}
                onEdit={onEdit}
                onResetEdits={onResetEdits}
              />
            </li>
          ))}
        </ul>
      )}

      {/* ── Pagination ──────────────────────────────────────────────────────── */}
      {pages > 1 && (
        <div className="flex items-center justify-between gap-3">
          <Button
            variant="outline"
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={current === 1}
          >
            <ChevronLeftIcon />
            {t('preview.previous')}
          </Button>

          <span className="text-body-sm text-muted-foreground tabular-nums" role="status">
            {t('preview.page', { page: current, pages })}
          </span>

          <Button
            variant="outline"
            onClick={() => setPage((p) => Math.min(pages, p + 1))}
            disabled={current === pages}
          >
            {t('preview.next')}
            <ChevronRightIcon />
          </Button>
        </div>
      )}
    </section>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// One question
// ─────────────────────────────────────────────────────────────────────────────

function QuestionCard({
  question,
  topics,
  difficultyLabels,
  disabled,
  open,
  onToggle,
  onEdit,
  onResetEdits,
}: {
  question: PreparedQuestion
  topics: { name: string; slug: string }[]
  difficultyLabels: Record<Difficulty, string>
  disabled: boolean
  open: boolean
  onToggle: () => void
  onEdit: (key: string, field: PreparedField, value: string) => void
  onResetEdits: (key: string) => void
}) {
  const t = useTranslations('import')
  const options = { A: question.optionA, B: question.optionB, C: question.optionC, D: question.optionD }

  return (
    <article
      className={
        question.errors.length > 0
          ? 'space-y-3 rounded-xl border border-destructive/40 bg-card p-4'
          : question.warnings.length > 0
            ? 'space-y-3 rounded-xl border border-warning/40 bg-card p-4'
            : 'space-y-3 rounded-xl border bg-card p-4'
      }
    >
      <header className="flex flex-wrap items-center gap-2">
        <span className="text-label-caps tabular-nums">
          {question.number === null ? t('preview.unnumbered') : `Q${question.number}`}
        </span>
        <span className="text-label-caps text-muted-foreground">{question.externalId || '—'}</span>

        <span className="ml-auto flex flex-wrap items-center gap-1.5">
          {question.edited && <Badge variant="info">{t('preview.edited')}</Badge>}
          <Badge variant="outline">{difficultyLabels[question.difficulty]}</Badge>
          <Badge variant="outline">{t(`preview.type.${question.qtype}`)}</Badge>
          {question.topicSlug && <Badge variant="outline">{question.topicSlug}</Badge>}
          <Badge variant={question.action === 'skip' ? 'ghost' : 'secondary'}>
            {t(`preview.action.${question.action}`)}
          </Badge>
        </span>
      </header>

      {/*
        No per-locale class and no dir attribute. --font-sans already lists a
        Devanagari and a Gujarati face beside the Latin one, so the browser
        picks a face per glyph and a Hindi question renders correctly inside an
        otherwise-English screen. Adding one here would be the drift the design
        system exists to prevent.
      */}
      <p className="text-body-md">{question.stem || t('preview.emptyStem')}</p>

      {question.qtype === 'mcq' ? (
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {OPTION_KEYS.map((letter) => {
            const correct = question.correctOption === letter
            return (
              <li
                key={letter}
                className={
                  correct
                    ? 'flex items-start gap-2 rounded-lg bg-success/10 px-2.5 py-1.5 text-body-sm'
                    : 'flex items-start gap-2 px-2.5 py-1.5 text-body-sm'
                }
              >
                <span
                  className={correct ? 'text-label-caps text-success' : 'text-label-caps text-muted-foreground'}
                >
                  {letter}
                </span>
                <span className={options[letter] ? '' : 'text-destructive'}>
                  {options[letter] ?? t('preview.missingOption')}
                </span>
                {correct && <CheckIcon aria-hidden className="ml-auto size-4 shrink-0 text-success" />}
              </li>
            )
          })}
        </ul>
      ) : (
        <div className="rounded-lg bg-muted/50 px-3 py-2 text-body-sm">
          <span className="text-label-caps text-muted-foreground">{t('preview.modelAnswer')}</span>{' '}
          <span className={question.answerText ? '' : 'text-destructive'}>
            {question.answerText ?? t('preview.missingAnswer')}
          </span>
        </div>
      )}

      {question.explanation && (
        <p className="text-body-sm text-muted-foreground">
          <span className="text-label-caps">{t('preview.why')}</span> {question.explanation}
        </p>
      )}

      {/* Marks are DETECTED and never stored — see ParsedQuestion. Shown so a
          document that disagrees with the one-mark rule is visible rather than
          silently flattened. */}
      {question.marks !== null && question.marks !== 1 && (
        <p className="text-body-sm text-muted-foreground tabular-nums">
          {t('preview.marksPrinted', { marks: question.marks })}
        </p>
      )}

      {(question.errors.length > 0 || question.warnings.length > 0) && (
        <ul className="space-y-1.5">
          {question.errors.map((finding, i) => (
            <FindingLine key={`e${i}`} finding={finding} tone="error" />
          ))}
          {question.warnings.map((finding, i) => (
            <FindingLine key={`w${i}`} finding={finding} tone="warning" />
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={onToggle} disabled={disabled}>
          {open ? <XIcon /> : <PencilIcon />}
          {open ? t('preview.done') : t('preview.edit')}
        </Button>
        {question.edited && (
          <Button variant="ghost" size="sm" onClick={() => onResetEdits(question.key)} disabled={disabled}>
            <RotateCcwIcon />
            {t('preview.revert')}
          </Button>
        )}
      </div>

      {open && (
        <QuestionEditor
          question={question}
          topics={topics}
          difficultyLabels={difficultyLabels}
          disabled={disabled}
          onEdit={onEdit}
        />
      )}
    </article>
  )
}

function FindingLine({ finding, tone }: { finding: Finding; tone: 'error' | 'warning' }) {
  const t = useTranslations('import')

  return (
    <li
      className={
        tone === 'error'
          ? 'flex items-start gap-2 text-body-sm text-destructive'
          : 'flex items-start gap-2 text-body-sm text-warning'
      }
    >
      <AlertTriangleIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>
        {finding.message}
        {/* The raw cause, one disclosure away. "constraint violation 23505" is
            not a sentence, and hiding it entirely leaves nothing to paste into
            a bug report. */}
        {finding.technical && (
          <details className="mt-1">
            <summary className="cursor-pointer text-body-sm text-muted-foreground">
              {t('technicalDetails')}
            </summary>
            <code className="mt-1 block font-mono text-xs break-all text-muted-foreground">
              {finding.technical}
            </code>
          </details>
        )}
      </span>
    </li>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Editing one question
// ─────────────────────────────────────────────────────────────────────────────

function QuestionEditor({
  question,
  topics,
  difficultyLabels,
  disabled,
  onEdit,
}: {
  question: PreparedQuestion
  topics: { name: string; slug: string }[]
  difficultyLabels: Record<Difficulty, string>
  disabled: boolean
  onEdit: (key: string, field: PreparedField, value: string) => void
}) {
  const t = useTranslations('import')
  const set = (field: PreparedField) => (value: string) => onEdit(question.key, field, value)

  return (
    <div className="space-y-4 rounded-lg border bg-muted/30 p-4">
      <Field id={`${question.key}-stem`} label={t('preview.field.stem')}>
        <Textarea
          id={`${question.key}-stem`}
          value={question.stem}
          disabled={disabled}
          onChange={(e) => set('stem')(e.target.value)}
        />
      </Field>

      {question.qtype === 'mcq' ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            {OPTION_KEYS.map((letter) => (
              <Field
                key={letter}
                id={`${question.key}-option-${letter}`}
                label={t('preview.field.option', { letter })}
              >
                <Textarea
                  id={`${question.key}-option-${letter}`}
                  value={
                    ({ A: question.optionA, B: question.optionB, C: question.optionC, D: question.optionD }[
                      letter
                    ] ?? '')
                  }
                  disabled={disabled}
                  onChange={(e) => set(`option${letter}` as PreparedField)(e.target.value)}
                />
              </Field>
            ))}
          </div>

          <Field id={`${question.key}-correct`} label={t('preview.field.correctOption')}>
            <Select
              value={question.correctOption ?? ''}
              onValueChange={(value) => set('correctOption')(value ?? '')}
              disabled={disabled}
            >
              <SelectTrigger id={`${question.key}-correct`} className="w-full sm:w-40">
                <SelectValue>{(value) => (value as string) || t('preview.notSet')}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {OPTION_KEYS.map((letter) => (
                  <SelectItem key={letter} value={letter}>
                    {letter}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </>
      ) : (
        <Field id={`${question.key}-answer`} label={t('preview.field.answerText')}>
          <Textarea
            id={`${question.key}-answer`}
            value={question.answerText ?? ''}
            disabled={disabled}
            onChange={(e) => set('answerText')(e.target.value)}
          />
        </Field>
      )}

      <Field id={`${question.key}-explanation`} label={t('preview.field.explanation')}>
        <Textarea
          id={`${question.key}-explanation`}
          value={question.explanation ?? ''}
          disabled={disabled}
          onChange={(e) => set('explanation')(e.target.value)}
        />
      </Field>

      <div className="grid gap-3 sm:grid-cols-3">
        <Field id={`${question.key}-external`} label={t('preview.field.externalId')}>
          <Input
            id={`${question.key}-external`}
            value={question.externalId}
            disabled={disabled}
            onChange={(e) => set('externalId')(e.target.value)}
          />
        </Field>

        <Field id={`${question.key}-type`} label={t('preview.field.qtype')}>
          <Select
            value={question.qtype}
            onValueChange={(value) => set('qtype')(value ?? question.qtype)}
            disabled={disabled || question.existing}
          >
            <SelectTrigger id={`${question.key}-type`} className="w-full">
              <SelectValue>{(value) => t(`preview.type.${value as 'mcq' | 'short_answer'}`)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {QUESTION_TYPES.map((qtype) => (
                <SelectItem key={qtype} value={qtype}>
                  {t(`preview.type.${qtype}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <Field id={`${question.key}-difficulty`} label={t('preview.field.difficulty')}>
          <Select
            value={question.difficulty}
            onValueChange={(value) => set('difficulty')(value ?? question.difficulty)}
            disabled={disabled || question.existing}
          >
            <SelectTrigger id={`${question.key}-difficulty`} className="w-full">
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
        </Field>
      </div>

      <Field id={`${question.key}-topic`} label={t('preview.field.topicSlug')}>
        <Select
          value={question.topicSlug ?? ''}
          onValueChange={(value) => set('topicSlug')(value ?? '')}
          disabled={disabled || question.existing}
        >
          <SelectTrigger id={`${question.key}-topic`} className="w-full sm:w-72">
            <SelectValue>
              {(value) => topics.find((topic) => topic.slug === value)?.name ?? t('preview.notSet')}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {topics.map((topic) => (
              <SelectItem key={topic.slug} value={topic.slug}>
                {topic.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {/*
        Said rather than merely enforced by a disabled control. A person who
        finds three fields greyed out and no explanation concludes the screen
        is broken; this tells them the bank is the authority and where to change
        it if they actually mean to.
      */}
      {question.existing && (
        <p className="text-body-sm text-muted-foreground">{t('preview.bankOwned')}</p>
      )}
    </div>
  )
}

function Field({
  id,
  label,
  children,
}: {
  id: string
  label: string
  children: React.ReactNode
}) {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} className="text-label-caps text-muted-foreground">
        {label}
      </Label>
      {children}
    </div>
  )
}

/**
 * "42" or "40-60".
 *
 * Anything else filters nothing rather than filtering everything — a half-typed
 * range must not blank the list under somebody's cursor.
 */
function parseRange(value: string): { from: number; to: number } | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  const single = trimmed.match(/^(\d+)$/)
  if (single) {
    const n = Number.parseInt(single[1], 10)
    return { from: n, to: n }
  }

  const span = trimmed.match(/^(\d+)\s*[-–]\s*(\d+)$/)
  if (span) {
    const from = Number.parseInt(span[1], 10)
    const to = Number.parseInt(span[2], 10)
    return from <= to ? { from, to } : { from: to, to: from }
  }

  return null
}

/** Re-exported so the panel and the preview cannot disagree about page size. */
export { PAGE_SIZE as PREVIEW_PAGE_SIZE }
export type { OptionKey }
