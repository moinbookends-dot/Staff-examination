'use client'

import { Link } from '@/lib/i18n/navigation'
import { useMemo, useState, useTransition } from 'react'
import { useRouter } from '@/lib/i18n/navigation'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import type { ItemPoolEntry, TopicPoolEntry } from '@/server/papers/availability'
import { useTranslations } from 'next-intl'
import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  DownloadIcon,
  FileTextIcon,
  KeyRoundIcon, MonitorPlayIcon,
  Loader2Icon,
  SparklesIcon,
} from 'lucide-react'
import { Button, buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { InlineError } from '@/components/ui/inline-error'
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
   * The brands this caller may draw from.
   *
   * A brand-pinned Chef receives exactly one and is shown no chooser — there
   * is no decision to make, and offering one would imply otherwise. An
   * unscoped Editor receives all of them and must pick, because a paper
   * belongs to exactly one brand's bank.
   */
  brands: { id: string; name: string }[]
  defaultBrandId: string | null
  /**
   * The level the URL names, so the server could load its topics. Kept
   * distinct from local state: the topic list is per level, and a level
   * chosen without a round trip would have no topics to show.
   */
  selectedDifficulty: Difficulty | null
  /** Topics carrying questions for this brand and level. Empty until both. */
  topicPool: TopicPoolEntry[]
  /** Recipes and menu items the questions are about. Empty until both. */
  itemPool: ItemPoolEntry[]
  /**
   * The eligible pool under the CURRENT selection, counted by the database.
   *
   * Not derived in the browser: a question can name two items, so subtracting
   * per-item counts double-removes it. The server recounts on every change.
   */
  eligible: { mcq: number; shortAnswer: number }
  /**
   * Marks one item in use or not. Absent when the viewer may not edit the
   * bank, which is what hides the controls — the same shape onGenerate uses.
   */
  onSetItemUsage?: (input: { itemId: string; inUse: boolean }) => Promise<{ ok: boolean; message?: string }>
  /**
   * The server action. Absent while the data adapter is unwired, which is what
   * disables the button rather than a separate "is it connected" flag — one
   * source of truth for whether generating is possible.
   */
  onGenerate?: (input: {
    difficulty: Difficulty
    marks: number
    brandId?: string
    topicIds?: string[]
    includeNoTopic?: boolean
    excludedItemIds?: string[]
    includeNoItem?: boolean
  }) => Promise<GenerateOutcome>
}

/**
 * How the untopiced bucket is tracked in a Set of ids.
 *
 * It genuinely has no id — bank_questions.topic_id is null — so it needs a
 * key that no uuid can collide with. It is never sent to the server; the
 * submit maps it back to the includeNoTopic flag the draw actually reads.
 */
const NO_TOPIC_KEY = '\u0000no-topic'
/** Same trick for the questions that name no known item. */
const NO_ITEM_KEY = '\u0000no-item'

export function GeneratePanel({
  availability,
  difficultyLabels,
  brands,
  defaultBrandId,
  selectedDifficulty,
  topicPool,
  itemPool,
  eligible,
  onSetItemUsage,
  onGenerate,
}: GeneratePanelProps) {
  const t = useTranslations('papers')
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  /*
   * The brand and the level are URL state, not component state: both decide
   * what the SERVER counted, and a copy held here could disagree with the
   * numbers on screen. That disagreement is the bug this screen had.
   */
  const difficulty = selectedDifficulty
  const brandId = defaultBrandId

  const [marks, setMarks] = useState<number | null>(availability.sizes[0] ?? null)
  const [outcome, setOutcome] = useState<GenerateOutcome | null>(null)

  /*
   * Excluded rather than included, so the DEFAULT IS EVERY TOPIC. A newly
   * loaded level starts with nothing excluded and behaves exactly as it did
   * before topics were selectable; a topic that vanishes from the pool
   * simply stops mattering rather than silently narrowing the next paper.
   */
  const [excluded, setExcluded] = useState<Set<string>>(new Set())

  /** Free-text filter over the item list. Local — it selects nothing. */
  const [itemSearch, setItemSearch] = useState('')
  const [itemError, setItemError] = useState<string | null>(null)

  const go = (next: { brand?: string | null; level?: Difficulty | null }) => {
    const params = new URLSearchParams()
    const brand = next.brand === undefined ? brandId : next.brand
    const level = next.level === undefined ? difficulty : next.level
    if (brand) params.set('brand', brand)
    if (level) params.set('level', level)
    setOutcome(null)
    // A different brand or level is a different pool, so a selection made
    // against the old one must not survive into the new one.
    setExcluded(new Set())
    router.push(`/papers/generate?${params.toString()}`)
  }

  /** The key an entry is tracked by. The untopiced bucket has no id. */
  const keyOf = (entry: TopicPoolEntry) => entry.id ?? NO_TOPIC_KEY

  const includedEntries = topicPool.filter((e) => !excluded.has(keyOf(e)))

  /*
   * COUNTED BY THE SERVER, not summed here.
   *
   * Topic counts could be added up — one topic per question. Item counts
   * cannot: a question naming two dishes appears under both, so summing
   * what is left after an exclusion removes it twice. The eligible figure
   * arrives already counted, from the same predicates the draw uses.
   */
  const eligibleTotal = eligible.mcq + eligible.shortAnswer

  const level = useMemo(
    () => availability.levels.find((l) => l.difficulty === difficulty) ?? null,
    [availability.levels, difficulty],
  )

  const combinations = level && marks ? (level.combinationsBySize[marks] ?? 0) : 0

  const levelTotal = level ? level.pool.mcq + level.pool.shortAnswer : 0

  const needle = itemSearch.trim().toLowerCase()
  const shownItems = needle
    ? itemPool.filter((i) => i.name.toLowerCase().includes(needle))
    : itemPool

  const notInUse = itemPool.filter((i) => !i.inUse)

  /*
   * Two groups rather than one list with strikethrough. A withdrawn dish is
   * a decision somebody made and may need to undo, and hunting for it among
   * forty-nine that are fine is the hard part — putting them together makes
   * "what have I taken off the menu" answerable at a glance.
   */
  const shownInUse = shownItems.filter((i) => i.inUse)
  const shownNotInUse = shownItems.filter((i) => !i.inUse)

  // Steps are numbered by what is actually on screen: a brand with no topics
  // and no items must not show a gap where steps 3 and 4 would have been.
  const summaryStep =
    2 +
    (difficulty && topicPool.length > 0 ? 1 : 0) +
    (difficulty && itemPool.length > 0 ? 1 : 0) +
    1

  /**
   * Put every item CURRENTLY SHOWN into one state.
   *
   * Bounded by the search, deliberately: "Deselect all" over 49 dishes is a
   * destructive-feeling action, and scoping it to what is on screen means
   * searching "pizza" and pressing it does the obvious, narrow thing rather
   * than quietly withdrawing the rest of the menu too.
   *
   * Only the items that would actually change are written — pressing
   * "Select all" when nine of ten are already in use is one write, not ten.
   */
  const setAllShown = (inUse: boolean) => {
    if (!onSetItemUsage) return

    const changing = shownItems.filter((i) => i.id !== null && i.inUse !== inUse)
    if (changing.length === 0) return

    setOutcome(null)
    startTransition(async () => {
      const results = await Promise.all(
        changing.map((i) => onSetItemUsage({ itemId: i.id as string, inUse })),
      )
      const failed = results.find((r) => !r.ok)
      setItemError(failed ? (failed.message ?? null) : null)
    })
  }

  const toggleItem = (item: ItemPoolEntry, inUse: boolean) => {
    if (!onSetItemUsage || item.id === null) return
    setOutcome(null)
    startTransition(async () => {
      const res = await onSetItemUsage({ itemId: item.id as string, inUse })
      // The server revalidates this route, so a success re-renders with the
      // new counts. A refusal is surfaced rather than left as a checkbox
      // that silently snapped back.
      if (!res.ok) setItemError(res.message ?? null)
      else setItemError(null)
    })
  }
  const excludedTotal = levelTotal - eligibleTotal

  /*
   * The blueprint the chosen size will demand, per section. Recomputed here
   * rather than imported so the check reads against the same 80/20 the
   * server enforces — and so "enough questions" means enough of EACH type,
   * not enough in total. A pool of 900 MCQs and 2 short answers is not a
   * pool that can fill a 20-mark paper.
   */
  const needMcq = marks ? (marks * 4) / 5 : 0
  const needShort = marks ? marks / 5 : 0

  const enough = eligible.mcq >= needMcq && eligible.shortAnswer >= needShort

  const ready = Boolean(
    difficulty && marks && brandId && onGenerate && combinations > 0 && enough,
  )

  const submit = () => {
    if (!difficulty || !marks || !onGenerate) return
    setOutcome(null)
    startTransition(async () => {
      // brandId is advisory: a pinned caller has theirs forced server-side and
      // this value is never reached.
      /*
       * The INCLUDED ids are sent, never the excluded ones. The server
       * intersects them with what the bank holds, so a stale checkbox can
       * only ever narrow the pool — an excluded-list would have to be
       * trusted to be complete, and a missing entry would admit the very
       * topic somebody removed.
       */
      setOutcome(
        await onGenerate({
          difficulty,
          marks,
          brandId: brandId ?? undefined,
          topicIds: includedEntries
            .map((e) => e.id)
            .filter((id): id is string => id !== null),
          includeNoTopic: includedEntries.some((e) => e.id === null),
          // The server adds every item already marked Not in Use, so this
          // list narrows the pool and can never widen it.
          excludedItemIds: notInUse
            .map((i) => i.id)
            .filter((id): id is string => id !== null),
          includeNoItem: itemPool.every((i) => i.id !== null) || notInUse.every((i) => i.id !== null),
        }),
      )
    })
  }

  return (
    <div className="space-y-6">
      {/*
        ── Brand ───────────────────────────────────────────────────────────
        Only when there is a choice. A brand-pinned Chef gets no step and no
        step number, because being shown a control with one option and no
        alternative is worse than being shown nothing.
      */}
      {brands.length > 1 && (
        <section className="space-y-2">
          <label className="text-label-caps text-muted-foreground" htmlFor="generate-brand">
            {t('brand')}
          </label>
          <select
            id="generate-brand"
            value={brandId ?? ''}
            onChange={(e) => go({ brand: e.target.value || null })}
            disabled={pending}
            className="w-full rounded-md border bg-card px-3 py-2 text-body-sm sm:w-80"
          >
            {brands.map((brand) => (
              <option key={brand.id} value={brand.id}>
                {brand.name}
              </option>
            ))}
          </select>
        </section>
      )}

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
            // A level with nothing in it cannot make a paper. Offering it as a
            // live choice is what let somebody pick Capiche Medium and be told
            // afterwards that the bank was empty.
            const empty = total === 0

            return (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={pending || empty}
                onClick={() => go({ level: value })}
                className={cn(
                  'rounded-xl border p-4 text-left transition-colors',
                  empty && 'cursor-not-allowed opacity-60',
                  selected
                    ? 'border-primary bg-primary/5 ring-1 ring-primary'
                    : 'border-border bg-card',
                  !empty && !selected && 'hover:border-primary/40',
                )}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="text-title-md">{difficultyLabels[value]}</span>
                  {selected && <CheckCircle2Icon aria-hidden className="size-5 text-primary" />}
                </span>
                <span className="mt-1 block text-body-sm text-muted-foreground tabular-nums">
                  {empty ? t('levelEmpty') : `${total} ${t('availableQuestions').toLowerCase()}`}
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
      {/*
        ── Step 3 — the question pool ──────────────────────────────────────
        Only once a level is chosen, because the topics are per level: Aiko's
        easy topics hold no hard questions at all, so a list drawn before the
        level was known would offer rows that exclude nothing.
      */}
      {difficulty && topicPool.length > 0 && (
        <Step index={3} title={t('stepPool')}>
          <div className="space-y-3 rounded-xl border bg-card p-4">
            <p className="text-body-sm text-muted-foreground">{t('poolHint')}</p>

            <ul className="grid gap-1 sm:grid-cols-2">
              {topicPool.map((entry) => {
                const key = keyOf(entry)
                const included = !excluded.has(key)
                const total = entry.pool.mcq + entry.pool.shortAnswer

                return (
                  <li key={key}>
                    <label className="flex items-center gap-2 rounded-md px-2 py-1.5 text-body-sm hover:bg-accent/40">
                      <Checkbox
                        checked={included}
                        disabled={pending}
                        onCheckedChange={(next) =>
                          setExcluded((current) => {
                            const updated = new Set(current)
                            if (next) updated.delete(key)
                            else updated.add(key)
                            return updated
                          })
                        }
                      />
                      <span className="min-w-0 flex-1 truncate">{entry.name}</span>
                      <span className="text-label-caps text-muted-foreground tabular-nums">
                        {total}
                      </span>
                    </label>
                  </li>
                )
              })}
            </ul>

          </div>
        </Step>
      )}

      {/*
        ── Recipe / Item Usage ─────────────────────────────────────────────
        A standing decision about the menu, edited here because this is where
        its effect is visible. Marking an item unused writes to the bank and
        re-renders the pool — it is not a per-paper checkbox.
      */}
      {difficulty && itemPool.length > 0 && (
        <Step index={topicPool.length > 0 ? 4 : 3} title={t('stepItems')}>
          <div className="space-y-3 rounded-xl border bg-card p-4">
            <p className="text-body-sm text-muted-foreground">{t('itemsHint')}</p>

            {itemError && <InlineError>{itemError}</InlineError>}

            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="search"
                value={itemSearch}
                disabled={pending}
                onChange={(e) => setItemSearch(e.target.value)}
                placeholder={t('itemsSearch')}
                aria-label={t('itemsSearch')}
                className="w-full sm:w-72"
              />
              <span className="text-body-sm text-muted-foreground tabular-nums">
                {t('itemsInUseCount', {
                  inUse: itemPool.length - notInUse.length,
                  total: itemPool.length,
                })}
              </span>

              {/* Both act on what the SEARCH is showing, which is why they
                  sit beside it rather than above the list. */}
              {onSetItemUsage && (
                <span className="ml-auto flex gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={pending || shownNotInUse.length === 0}
                    onClick={() => setAllShown(true)}
                  >
                    {t('itemsSelectAll')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={pending || shownInUse.length === 0}
                    onClick={() => setAllShown(false)}
                  >
                    {t('itemsDeselectAll')}
                  </Button>
                </span>
              )}
            </div>

            {shownItems.length === 0 ? (
              <p className="py-2 text-body-sm text-muted-foreground">
                {t('itemsNoMatch', { search: itemSearch })}
              </p>
            ) : (
              <div className="space-y-4">
                <ItemGroup
                  title={t('itemsInUse')}
                  items={shownInUse}
                  editable={Boolean(onSetItemUsage)}
                  pending={pending}
                  onToggle={toggleItem}
                />
                {/* Rendered only when there is something in it. An empty
                    "Not in use" heading reads as a section that failed to load
                    rather than as a menu with nothing withdrawn. */}
                {shownNotInUse.length > 0 && (
                  <ItemGroup
                    title={t('itemsNotInUse')}
                    items={shownNotInUse}
                    editable={Boolean(onSetItemUsage)}
                    pending={pending}
                    onToggle={toggleItem}
                  />
                )}
              </div>
            )}

            {/*
              ── Question availability ────────────────────────────────────
              One block, not one per filter. Somebody about to press Generate
              is asking a single question — "will this work?" — and answering
              it in two places, each describing a different subset, is how a
              screen ends up contradicting itself.

              Every figure comes from the database. `eligible` is counted by
              bank_eligible_counts with the same predicates the draw uses, so
              subtraction never has to be trusted: a question naming two
              withdrawn dishes is removed once, not twice.
            */}
            <dl className="grid grid-cols-2 gap-4 border-t pt-3 sm:grid-cols-4">
              <PoolFigure label={t('poolTotal')} value={levelTotal} />
              <PoolFigure label={t('poolExcluded')} value={excludedTotal} />
              <PoolFigure label={t('poolEligible')} value={eligibleTotal} />
              {marks && <PoolFigure label={t('poolRequested')} value={marks} />}
            </dl>

            {marks && (
              <p
                role="status"
                className={cn(
                  'text-body-sm',
                  enough ? 'text-muted-foreground' : 'text-destructive',
                )}
              >
                {enough
                  ? t('poolEnough', { requested: marks })
                  : t('poolShort', {
                      requested: marks,
                      mcqNeeded: needMcq,
                      mcqAvailable: eligible.mcq,
                      shortNeeded: needShort,
                      shortAvailable: eligible.shortAnswer,
                    })}
              </p>
            )}
          </div>
        </Step>
      )}

      <Step index={summaryStep} title={t('stepSummary')}>
        <div className="rounded-xl border bg-card">
          <div className="grid gap-4 p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-center sm:gap-6">
            {/*
              The ELIGIBLE count, not the level's. This metric is the promise
              the Generate button makes, and it has to describe the pool the
              draw will use or it is the old bug in a new place.
            */}
            <Metric
              label={t('availableQuestions')}
              value={level ? String(topicPool.length > 0 ? eligibleTotal : levelTotal) : '—'}
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

/** One figure in the pool arithmetic. A <dl> pair, not a Metric: these are
 *  three related numbers of one calculation rather than headline stats. */
/**
 * One headed list of recipes, either in use or withdrawn.
 *
 * The two groups are the same control drawn twice rather than one list
 * sorted by state: the question a person brings to this screen is "what have
 * I taken off the menu", and an answer they have to assemble by scanning for
 * struck-through rows is not an answer.
 */
function ItemGroup({
  title,
  items,
  editable,
  pending,
  onToggle,
}: {
  title: string
  items: ItemPoolEntry[]
  editable: boolean
  pending: boolean
  onToggle: (item: ItemPoolEntry, inUse: boolean) => void
}) {
  return (
    <section>
      <h3 className="text-label-caps text-muted-foreground">
        {title} <span className="tabular-nums">({items.length})</span>
      </h3>
      <ul className="mt-2 grid gap-1 sm:grid-cols-2">
        {items.map((item) => (
          <li key={item.id ?? NO_ITEM_KEY}>
            <label
              className={cn(
                'flex items-center gap-2 rounded-md px-2 py-1.5 text-body-sm',
                item.id !== null && editable && 'hover:bg-accent/40',
                !item.inUse && 'text-muted-foreground',
              )}
            >
              <Checkbox
                checked={item.inUse}
                /* The no-item bucket is a residue, not a dish: there is
                   nothing to take off a menu, so it is shown for its count
                   and cannot be toggled here. */
                disabled={pending || !editable || item.id === null}
                onCheckedChange={(next) => onToggle(item, Boolean(next))}
                aria-label={item.name}
              />
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              <span className="text-label-caps text-muted-foreground tabular-nums">
                {item.questionCount}
              </span>
            </label>
          </li>
        ))}
      </ul>
    </section>
  )
}

function PoolFigure({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-label-caps text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-title-md tabular-nums">{value}</dd>
    </div>
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

        {/*
          ┌───────────────────────────────────────────────────────────────────┐
          │ THE WAY FORWARD, WHICH THIS PANEL DID NOT HAVE.                   │
          │                                                                   │
          │ It offered six downloads and stopped. To publish the paper it had │
          │ just made, somebody had to leave the page, open Exam History,     │
          │ find the paper by number, and scroll past three sections — for a  │
          │ paper whose id was already in hand right here.                    │
          │                                                                   │
          │ Publishing itself is NOT duplicated: this links to the paper,     │
          │ where PublishPaper lives. A second publish form would be a second │
          │ set of validation rules to keep in step with 0064.                │
          └───────────────────────────────────────────────────────────────────┘
        */}
        <div className="mt-4 flex flex-wrap gap-2">
          <Link
            href={`/history/${outcome.paperId}`}
            className={cn(buttonVariants({ size: 'sm' }))}
          >
            <MonitorPlayIcon />
            {t('generatePublishNow')}
          </Link>
          <Link
            href="/history"
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }))}
          >
            {t('viewInHistory')}
          </Link>
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
