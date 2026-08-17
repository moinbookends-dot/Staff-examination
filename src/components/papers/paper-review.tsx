'use client'

import { useMemo, useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckCircle2Icon,
  Loader2Icon,
  RotateCcwIcon,
  SearchIcon,
  TriangleAlertIcon,
  XIcon,
} from 'lucide-react'
import {
  findEligibleQuestions,
  savePaperQuestions,
  type SavePaperResult,
} from '@/server/actions/papers'
import type { EligibleQuestion, PaperReviewQuestion } from '@/server/papers/paper-edit'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { InlineError } from '@/components/ui/inline-error'
import { cn } from '@/lib/utils'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Review a generated paper, and change it before it is published.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ EVERY EDIT IS LOCAL UNTIL SAVE. NO REQUEST PER KEYSTROKE OR PER NUDGE.    ║
 * ║                                                                           ║
 * ║ Remove, replace, move up and move down all mutate a React array and       ║
 * ║ nothing else. One deliberate Save sends the whole list to                 ║
 * ║ edit_paper_questions(), which re-checks every rule and either accepts the ║
 * ║ paper or refuses it entirely.                                            ║
 * ║                                                                           ║
 * ║ Two reasons, and the second is the important one:                        ║
 * ║                                                                           ║
 * ║ 1. A round trip to this project costs a measured ~120ms. Paying that to   ║
 * ║    move question 7 up one place would make reordering feel broken.        ║
 * ║                                                                           ║
 * ║ 2. The rules are properties of the WHOLE paper — the 16/4 split, twenty   ║
 * ║    questions, no repeats. A paper saved one change at a time is invalid   ║
 * ║    between changes, and a paper that is invalid at rest is a paper that   ║
 * ║    can be published in that state.                                       ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * WHAT IS DELIBERATELY NOT HERE: an optimistic "saved". The list moves freely
 * in the browser, but whether the SAVE succeeded is answered by the server and
 * nothing else — a cheerful tick over a paper the database refused (a duplicate
 * combination, an archived question) would be a lie about an exam.
 *
 * Drag-and-drop is also absent on purpose. Up/down buttons are keyboard
 * operable, screen-reader operable and work on a phone, which drag handles
 * are not and do not; the ordering of twenty items does not need more.
 * ═══════════════════════════════════════════════════════════════════════════
 */

interface Slot {
  questionId: string
  section: 'mcq' | 'short_answer'
  question: string
  topicName: string | null
  locales: string[]
}

export function PaperReview({
  paperId,
  paperNo,
  editable,
  mcqExpected,
  shortExpected,
  initial,
}: {
  paperId: string
  paperNo: number
  editable: boolean
  mcqExpected: number
  shortExpected: number
  initial: PaperReviewQuestion[]
}) {
  const t = useTranslations('papers')

  const asSlots = (rows: PaperReviewQuestion[]): Slot[] =>
    rows.map((r) => ({
      questionId: r.questionId,
      section: r.section,
      question: r.question,
      topicName: r.topicName,
      locales: r.locales,
    }))

  const [slots, setSlots] = useState<Slot[]>(() => asSlots(initial))
  const [saved, setSaved] = useState<Slot[]>(() => asSlots(initial))
  const [result, setResult] = useState<SavePaperResult | null>(null)
  const [saving, startSaving] = useTransition()

  // Which slot the picker is filling. null = closed.
  const [picking, setPicking] = useState<number | null>(null)

  const dirty = useMemo(
    () =>
      slots.length !== saved.length ||
      slots.some((s, i) => s.questionId !== saved[i]?.questionId),
    [slots, saved],
  )

  const mcq = slots.filter((s) => s.section === 'mcq').length
  const short = slots.filter((s) => s.section === 'short_answer').length
  const valid = mcq === mcqExpected && short === shortExpected

  const move = (from: number, to: number) => {
    if (to < 0 || to >= slots.length) return
    const next = [...slots]
    const [row] = next.splice(from, 1)
    next.splice(to, 0, row)
    setSlots(next)
    setResult(null)
  }

  const remove = (index: number) => {
    setSlots(slots.filter((_, i) => i !== index))
    setResult(null)
  }

  const replace = (index: number, q: EligibleQuestion) => {
    const next = [...slots]
    next[index] = {
      questionId: q.questionId,
      section: q.qtype,
      question: q.question,
      topicName: q.topicName,
      locales: q.locales,
    }
    setSlots(next)
    setPicking(null)
    setResult(null)
  }

  const save = () => {
    startSaving(async () => {
      const r = await savePaperQuestions({
        paperId,
        questions: slots.map((s, i) => ({
          questionId: s.questionId,
          questionNo: i + 1,
          section: s.section,
        })),
      })
      setResult(r)
      // Only a confirmed save moves the baseline. Otherwise "unsaved changes"
      // would disappear while the changes were, in fact, unsaved.
      if (r.ok) setSaved(slots)
    })
  }

  if (!editable) {
    return (
      <div className="rounded-lg border bg-muted/30 p-4">
        <p className="flex items-center gap-2 text-sm font-medium">
          <CheckCircle2Icon aria-hidden className="size-4 text-muted-foreground" />
          {t('reviewFrozenTitle')}
        </p>
        <p className="mt-1 text-sm text-muted-foreground text-balance">
          {t('reviewFrozenBody')}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* ── Composition, always visible ────────────────────────────────── */}
      <div
        className={cn(
          'flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3',
          valid ? 'bg-card' : 'border-warning/40 bg-warning/8',
        )}
      >
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span className="font-medium">
            {t('reviewCount', { n: slots.length, expected: mcqExpected + shortExpected })}
          </span>
          <span className={cn(mcq === mcqExpected ? 'text-muted-foreground' : 'text-warning')}>
            {t('reviewMcq', { n: mcq, expected: mcqExpected })}
          </span>
          <span className={cn(short === shortExpected ? 'text-muted-foreground' : 'text-warning')}>
            {t('reviewShort', { n: short, expected: shortExpected })}
          </span>
        </div>

        <div className="flex items-center gap-2">
          {dirty && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setSlots(saved)
                setResult(null)
              }}
              disabled={saving}
            >
              <RotateCcwIcon />
              {t('reviewDiscard')}
            </Button>
          )}
          <Button size="sm" onClick={save} disabled={!dirty || saving}>
            {saving && <Loader2Icon className="animate-spin" />}
            {saving ? t('reviewSaving') : t('reviewSave')}
          </Button>
        </div>
      </div>

      {/*
        The shortfall, stated plainly and WITHOUT offering a way past it.
        The database refuses a paper of the wrong shape, so a "proceed anyway"
        button here would be a button that always fails.
      */}
      {!valid && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/8 p-3 text-sm"
        >
          <TriangleAlertIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
          <span>{t('reviewInvalid', { mcq: mcqExpected, short: shortExpected })}</span>
        </p>
      )}

      {dirty && (
        <p className="text-xs text-muted-foreground">{t('reviewUnsaved')}</p>
      )}

      {result && !result.ok && <InlineError>{result.message}</InlineError>}
      {result?.ok && (
        <p role="status" className="flex items-center gap-2 text-sm text-success">
          <CheckCircle2Icon aria-hidden className="size-4" />
          {t('reviewSaved', { paperNo: result.paperNo, n: result.questions })}
        </p>
      )}

      {/* ── The questions ───────────────────────────────────────────────── */}
      <ol className="space-y-2">
        {slots.map((slot, index) => (
          <li key={`${slot.questionId}-${index}`} className="rounded-lg border bg-card p-3">
            <div className="flex flex-wrap items-start gap-3">
              <span className="grid size-7 shrink-0 place-items-center rounded-md border text-label-caps">
                {index + 1}
              </span>

              <div className="min-w-0 flex-1">
                <p className="text-sm">{slot.question || t('reviewNoText')}</p>
                <p className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                  <span>{slot.section === 'mcq' ? t('typeMcq') : t('typeShort')}</span>
                  {slot.topicName && <span>{slot.topicName}</span>}
                  <span>{slot.locales.join(', ').toUpperCase()}</span>
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-1">
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('reviewMoveUp', { n: index + 1 })}
                  disabled={index === 0 || saving}
                  onClick={() => move(index, index - 1)}
                >
                  <ArrowUpIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('reviewMoveDown', { n: index + 1 })}
                  disabled={index === slots.length - 1 || saving}
                  onClick={() => move(index, index + 1)}
                >
                  <ArrowDownIcon />
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={saving}
                  onClick={() => setPicking(picking === index ? null : index)}
                >
                  {t('reviewReplace')}
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t('reviewRemove', { n: index + 1 })}
                  disabled={saving}
                  onClick={() => remove(index)}
                >
                  <XIcon />
                </Button>
              </div>
            </div>

            {picking === index && (
              <QuestionPicker
                paperId={paperId}
                wanted={slot.section}
                onCancel={() => setPicking(null)}
                onChoose={(q) => replace(index, q)}
              />
            )}
          </li>
        ))}
      </ol>

      {slots.length === 0 && (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t('reviewEmpty', { paperNo })}
        </p>
      )}
    </div>
  )
}

/**
 * The replacement picker.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ NO FILTER IS PRE-SELECTED, AND DIFFICULTY IS NOT OFFERED AT ALL.          │
 * │                                                                           │
 * │ Difficulty is fixed for the whole paper at generation and the RPC reads   │
 * │ it from the paper rather than accepting it, so a difficulty control here  │
 * │ would imply a paper can mix levels. It cannot, and the product rule is    │
 * │ that difficulty is never inferred.                                        │
 * │                                                                           │
 * │ The type IS pinned — to the slot being filled — because putting a short   │
 * │ answer in an MCQ slot breaks the 80/20 split the database then refuses.   │
 * │ Everything else the user chooses deliberately or leaves alone.            │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
function QuestionPicker({
  paperId,
  wanted,
  onChoose,
  onCancel,
}: {
  paperId: string
  wanted: 'mcq' | 'short_answer'
  onChoose: (q: EligibleQuestion) => void
  onCancel: () => void
}) {
  const t = useTranslations('papers')
  const [search, setSearch] = useState('')
  const [rows, setRows] = useState<EligibleQuestion[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, startLoading] = useTransition()

  /*
   * Searched on submit, not on every keystroke.
   *
   * Each search is a database round trip (~120ms measured), and a
   * search-as-you-type over the question bank would fire one per character —
   * with the answers arriving out of order. A deliberate submit is also how
   * the rest of this application behaves.
   */
  const run = (nextSearch: string) => {
    startLoading(async () => {
      const r = await findEligibleQuestions({
        paperId,
        qtype: wanted,
        search: nextSearch.trim() === '' ? null : nextSearch.trim(),
      })
      if (r.ok) {
        setRows(r.questions)
        setError(null)
      } else {
        setRows([])
        setError(r.message)
      }
    })
  }

  // Opened but not yet searched: show the first page rather than an empty box.
  if (rows === null && !loading && !error) run('')

  return (
    <div className="mt-3 rounded-lg border bg-muted/20 p-3">
      <form
        className="flex flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          run(search)
        }}
      >
        <div className="relative min-w-0 flex-1">
          <SearchIcon
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-3 my-auto size-4 text-muted-foreground"
          />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t('reviewSearch')}
            aria-label={t('reviewSearch')}
            className="pl-9"
          />
        </div>
        <Button type="submit" variant="outline" size="sm" disabled={loading}>
          {loading && <Loader2Icon className="animate-spin" />}
          {t('reviewSearchGo')}
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t('reviewCancel')}
        </Button>
      </form>

      {error && <InlineError className="mt-2">{error}</InlineError>}

      <ul className="mt-3 max-h-72 space-y-1 overflow-y-auto">
        {(rows ?? []).map((q) => (
          <li key={q.questionId}>
            <button
              type="button"
              onClick={() => onChoose(q)}
              className="w-full rounded-md border bg-card p-2 text-left text-sm transition-colors hover:bg-accent/40 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
            >
              <span className="block">{q.question || t('reviewNoText')}</span>
              <span className="mt-0.5 block text-xs text-muted-foreground">
                {q.topicName ?? t('reviewNoTopic')} · {q.locales.join(', ').toUpperCase()}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {rows !== null && rows.length === 0 && !error && (
        <p className="mt-2 text-sm text-muted-foreground">{t('reviewNoMatches')}</p>
      )}
    </div>
  )
}
