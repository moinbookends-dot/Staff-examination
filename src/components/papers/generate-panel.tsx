'use client'

import { useMemo, useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  DownloadIcon,
  FileTextIcon,
  KeyRoundIcon,
  Loader2Icon,
  SparklesIcon,
} from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { DIFFICULTIES, type Difficulty } from '@/lib/bank/vocabulary'
import { formatCombinationCount, isRunningLow } from '@/lib/papers/format'
import { isEffectivelyUnlimited } from '@/lib/papers/combinations'
import type { GenerateAvailability } from '@/server/papers/availability'
import { cn } from '@/lib/utils'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Generate Exam, per the Stitch design.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ ONE DIFFICULTY, NOT A WEIGHTED MIX.                                       ║
 * ║                                                                           ║
 * ║ The desktop Stitch screen shows Easy/Medium/Hard each with a target       ║
 * ║ percentage, as though a paper blends all three. The mobile screen shows a ║
 * ║ single choice, and the single choice is the product: a paper is drawn     ║
 * ║ entirely from ONE level.                                                  ║
 * ║                                                                           ║
 * ║ That is not a simplification — the exhaustion arithmetic counts           ║
 * ║ combinations within one pool, and the generator takes one difficulty.     ║
 * ║ These are radio buttons wearing the design's card styling.                ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE 80/20 SPLIT IS SHOWN AND NEVER OFFERED.                               │
 * │                                                                           │
 * │ Each size card prints its own breakdown — "16 MCQ · 4 short answer" —     │
 * │ derived by blueprintFor() on the server. There is no control to change    │
 * │ it, because with one mark per question a size DETERMINES its split; a     │
 * │ field here could only ever be wrong.                                      │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ NO HASHES, EPOCHS OR ATTEMPT COUNTS REACH THIS SCREEN.                    │
 * │                                                                           │
 * │ The Chef's question is "can I get a fresh paper?". The answers are yes,   │
 * │ not enough questions, or none left. Everything else is machinery they     │
 * │ cannot act on.                                                            │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Mirrors GenerateResult from src/lib/papers/generate.ts, minus internals. */
export type GenerateOutcome =
  | {
      status: 'generated'
      paperNo: number
      paperId: string
      totalCombinations: number
      unlimited: boolean
    }
  | {
      status: 'short'
      shortfalls: { qtype: 'mcq' | 'short_answer'; needed: number; available: number }[]
      marks: number
    }
  | { status: 'exhausted' }
  | { status: 'failed'; message: string }

export interface GeneratePanelProps {
  availability: GenerateAvailability
  difficultyLabels: Record<Difficulty, string>
  /**
   * The server action. Absent while the data adapter is unwired, which is what
   * disables the button rather than a separate "is it connected" flag — one
   * source of truth for whether generating is possible.
   */
  onGenerate?: (input: { difficulty: Difficulty; marks: number }) => Promise<GenerateOutcome>
}

export function GeneratePanel({
  availability,
  difficultyLabels,
  onGenerate,
}: GeneratePanelProps) {
  const t = useTranslations('papers')
  const [pending, startTransition] = useTransition()

  const [difficulty, setDifficulty] = useState<Difficulty | null>(null)
  const [marks, setMarks] = useState<number | null>(availability.sizes[0] ?? null)
  const [outcome, setOutcome] = useState<GenerateOutcome | null>(null)

  const level = useMemo(
    () => availability.levels.find((l) => l.difficulty === difficulty) ?? null,
    [availability.levels, difficulty],
  )

  const combinations = level && marks ? (level.combinationsBySize[marks] ?? 0) : 0
  const ready = Boolean(difficulty && marks && onGenerate && combinations > 0)

  const submit = () => {
    if (!difficulty || !marks || !onGenerate) return
    setOutcome(null)
    startTransition(async () => {
      setOutcome(await onGenerate({ difficulty, marks }))
    })
  }

  return (
    <div className="space-y-6">
      {/* ── Step 1 — difficulty ─────────────────────────────────────────── */}
      <Step index={1} title={t('stepDifficulty')}>
        <div
          role="radiogroup"
          aria-label={t('stepDifficulty')}
          className="grid gap-3 sm:grid-cols-3"
        >
          {DIFFICULTIES.map((value) => {
            const pool = availability.levels.find((l) => l.difficulty === value)?.pool
            const total = (pool?.mcq ?? 0) + (pool?.shortAnswer ?? 0)
            const selected = difficulty === value

            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={pending}
                onClick={() => setDifficulty(value)}
                className={cn(
                  'rounded-xl border p-4 text-left transition-colors',
                  selected
                    ? 'border-primary bg-primary/5 ring-1 ring-primary'
                    : 'border-border bg-card hover:border-primary/40',
                )}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="text-title-md">{difficultyLabels[value]}</span>
                  {selected && <CheckCircle2Icon aria-hidden className="size-5 text-primary" />}
                </span>
                <span className="mt-1 block text-body-sm text-muted-foreground">
                  {total} {t('availableQuestions').toLowerCase()}
                </span>
              </button>
            )
          })}
        </div>
      </Step>

      {/* ── Step 2 — paper size ─────────────────────────────────────────── */}
      <Step index={2} title={t('stepFormat')}>
        <div role="radiogroup" aria-label={t('stepFormat')} className="grid gap-3 sm:grid-cols-2">
          {availability.sizes.map((size, i) => {
            const selected = marks === size
            // Derived on the server from blueprintFor(); shown, never editable.
            const mcq = (size * 4) / 5
            const short = size / 5

            return (
              <button
                key={size}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={pending}
                onClick={() => setMarks(size)}
                className={cn(
                  'rounded-xl border p-4 text-left transition-colors',
                  selected
                    ? 'border-primary bg-primary/5 ring-1 ring-primary'
                    : 'border-border bg-card hover:border-primary/40',
                )}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="text-title-md">
                    {i === 0 ? t('sizeStandard') : t('sizeComprehensive')}
                  </span>
                  <Badge variant={selected ? 'default' : 'outline'}>
                    {t('sizeMarks', { marks: size })}
                  </Badge>
                </span>
                <span className="mt-1 block text-body-sm text-muted-foreground">
                  {t('sizeBreakdown', { mcq, short })}
                </span>
              </button>
            )
          })}
        </div>
      </Step>

      {/* ── Step 3 — summary and the button ─────────────────────────────── */}
      <Step index={3} title={t('stepSummary')}>
        <div className="rounded-xl border bg-card">
          <div className="grid gap-4 p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-center sm:gap-6">
            <Metric
              label={t('availableQuestions')}
              value={level ? String(level.pool.mcq + level.pool.shortAnswer) : '—'}
            />
            <Metric
              label={t('possiblePapers')}
              value={
                !level || !marks
                  ? '—'
                  : isEffectivelyUnlimited(combinations)
                    ? t('unlimited')
                    : formatCombinationCount(combinations)
              }
            />
            <Button
              type="button"
              size="lg"
              className="w-full sm:w-auto"
              disabled={!ready || pending}
              onClick={submit}
            >
              {pending ? (
                <>
                  <Loader2Icon className="animate-spin" />
                  {t('generating')}
                </>
              ) : (
                <>
                  <SparklesIcon />
                  {t('generate')}
                </>
              )}
            </Button>
          </div>

          {/* A nudge while there is still time to act on it, not an error. */}
          {level && marks && isRunningLow(combinations) && (
            <p className="border-t px-4 py-3 text-body-sm text-muted-foreground">
              {t('runningLow', { count: combinations })}
            </p>
          )}
        </div>
      </Step>

      {/* ── Outcome ─────────────────────────────────────────────────────── */}
      {outcome && <Outcome outcome={outcome} />}
    </div>
  )
}

function Step({
  index,
  title,
  children,
}: {
  index: number
  title: string
  children: React.ReactNode
}) {
  return (
    <section className="space-y-3">
      <h2 className="flex items-center gap-3">
        <span
          aria-hidden
          className="grid size-7 shrink-0 place-items-center rounded-full bg-primary text-label-caps text-primary-foreground"
        >
          {index}
        </span>
        <span className="text-title-md">{title}</span>
      </h2>
      {children}
    </section>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <span className="block truncate text-label-caps text-muted-foreground">{label}</span>
      <span className="mt-1 block truncate text-headline-lg">{value}</span>
    </div>
  )
}

/**
 * The four end states, each rendered from the generator's own result.
 *
 * `short` prints the pools the generator reported rather than a generic
 * sentence, because "you need 4 more short answers at this level" is the only
 * version of this message somebody can act on.
 */
function Outcome({ outcome }: { outcome: GenerateOutcome }) {
  const t = useTranslations('papers')

  if (outcome.status === 'generated') {
    return (
      <Panel tone="success" icon={<CheckCircle2Icon className="size-5" />} title={t('successTitle')}>
        <p className="text-body-sm">{t('successBody', { paperNo: outcome.paperNo })}</p>

        {/*
          Six files: paper + key in each of the three languages. Grouped by
          language rather than by kind, because somebody printing for a Hindi
          outlet wants both of that outlet's files together.
        */}
        <div className="mt-4 grid gap-2 sm:grid-cols-3">
          {(['en', 'hi', 'gu'] as const).map((locale) => (
            <div key={locale} className="rounded-lg border bg-card p-3">
              <span className="text-label-caps text-muted-foreground">{locale}</span>
              {/*
                buttonVariants on a plain <a>, not <Button asChild> — this
                project's Button is a Base UI primitive with no asChild prop.
                components/ui/export-link.tsx established the pattern.

                A real anchor rather than a click handler: these are file
                downloads, so middle-click, right-click → save and a long-press
                on a phone all have to work.
              */}
              <div className="mt-2 flex flex-col gap-1.5">
                <a
                  href={`/api/papers/${outcome.paperId}/${locale}/paper.pdf`}
                  className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                >
                  <FileTextIcon />
                  {t('downloadPaper')}
                </a>
                <a
                  href={`/api/papers/${outcome.paperId}/${locale}/key.pdf`}
                  className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                >
                  <KeyRoundIcon />
                  {t('downloadKey')}
                </a>
              </div>
            </div>
          ))}
        </div>
      </Panel>
    )
  }

  if (outcome.status === 'short') {
    return (
      <Panel tone="warning" icon={<AlertTriangleIcon className="size-5" />} title={t('shortTitle')}>
        <ul className="space-y-1 text-body-sm">
          {outcome.shortfalls.map((s) => (
            <li key={s.qtype}>
              {t('shortBody', {
                marks: outcome.marks,
                needed: s.needed,
                available: s.available,
                type: s.qtype === 'mcq' ? t('typeMcq') : t('typeShort'),
              })}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-body-sm text-muted-foreground">{t('shortHint')}</p>
      </Panel>
    )
  }

  if (outcome.status === 'exhausted') {
    return (
      <Panel tone="warning" icon={<AlertTriangleIcon className="size-5" />} title={t('exhaustedTitle')}>
        <p className="text-body-sm">{t('exhaustedBody')}</p>
      </Panel>
    )
  }

  return (
    <Panel tone="error" icon={<AlertTriangleIcon className="size-5" />} title={t('errorTitle')}>
      <p className="text-body-sm">{outcome.message}</p>
    </Panel>
  )
}

function Panel({
  tone,
  icon,
  title,
  children,
}: {
  tone: 'success' | 'warning' | 'error'
  icon: React.ReactNode
  title: string
  children: React.ReactNode
}) {
  return (
    <section
      // A border and an icon carry the meaning as well as the tint — a tinted
      // background alone is invisible to anyone who cannot distinguish it.
      className={cn(
        'rounded-xl border p-4',
        tone === 'success' && 'border-success/40 bg-success/5',
        tone === 'warning' && 'border-warning/40 bg-warning/5',
        tone === 'error' && 'border-destructive/40 bg-destructive/5',
      )}
      aria-live="polite"
    >
      <h3 className="flex items-center gap-2 text-title-md">
        <span
          aria-hidden
          className={cn(
            tone === 'success' && 'text-success',
            tone === 'warning' && 'text-warning',
            tone === 'error' && 'text-destructive',
          )}
        >
          {icon}
        </span>
        {title}
      </h3>
      <div className="mt-2">{children}</div>
    </section>
  )
}

/** Shown instead of the panel while the bank is empty. */
export function GenerateEmptyState() {
  const t = useTranslations('papers')
  return (
    <div className="rounded-xl border border-dashed bg-card p-10 text-center">
      <DownloadIcon aria-hidden className="mx-auto size-8 text-muted-foreground/60" />
      <h2 className="mt-4 text-title-md">{t('noBankTitle')}</h2>
      <p className="mx-auto mt-1 max-w-sm text-body-sm text-muted-foreground">{t('noBankBody')}</p>
    </div>
  )
}
