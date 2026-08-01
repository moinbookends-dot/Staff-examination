'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from '@/lib/i18n/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { saveSections, previewRuleCount, type RuleCount } from '@/server/actions/exams'
import type { CategoryOption } from '@/server/actions/questions'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, Redo2Icon, Undo2Icon, XIcon } from 'lucide-react'
import { DndContext, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core'
import { restrictToVerticalAxis, restrictToParentElement } from '@dnd-kit/modifiers'
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { SortableRow } from './sortable-row'
import {
  canRedo,
  canUndo,
  initHistory,
  moveItem,
  record,
  redo,
  undo,
  type History,
} from '@/lib/exams/history'

/**
 * Sections and their selection rules.
 *
 * TWO NUMBERS BESIDE EVERY RULE, and the second is the one that earns its keep:
 *
 *   available — what this rule matches on its own, within its difficulty band
 *   drawn     — what it actually gets once earlier rules have taken theirs
 *
 * A single number would say "23 questions match" for two rules competing over
 * the same 23, and publish would then refuse both. `available` updates live as
 * the chef edits; `drawn` needs the real draw, so it refreshes on save.
 */

export interface RuleDraft {
  key: string
  id?: string
  categoryId: string | null
  includeSubcategories: boolean
  difficultyMin: number
  difficultyMax: number
  questionCount: number
  marksPerQuestion: number | null
}

export interface SectionDraft {
  key: string
  id?: string
  title: string
  instructions: string
  rules: RuleDraft[]
}

let keySeed = 0
const nextKey = () => `k${++keySeed}`

export function SectionBuilder({
  examId,
  initialSections,
  categories,
  ruleCounts,
  readOnly,
}: {
  examId: string
  initialSections: SectionDraft[]
  categories: CategoryOption[]
  ruleCounts: RuleCount[]
  readOnly?: boolean
}) {
  const router = useRouter()
  const t = useTranslations('exams.sections')
  const [pending, startTransition] = useTransition()
  const [history, setHistory] = useState<History<SectionDraft[]>>(() =>
    initHistory(initialSections),
  )
  const sections = history.present
  const [error, setError] = useState<string | null>(null)

  const counts = new Map(ruleCounts.map((c) => [c.rule_id, c]))
  const disabled = pending || Boolean(readOnly)

  /**
   * Every mutation goes through here, so nothing can change the draft without
   * becoming undoable. `label` decides coalescing: a title being typed is one
   * undo step, adding a section is another. See src/lib/exams/history.ts.
   */
  const commit = (next: SectionDraft[], label: string | null = null) =>
    setHistory((current) => record(current, next, label))

  const setSections = (
    updater: SectionDraft[] | ((current: SectionDraft[]) => SectionDraft[]),
    label: string | null = null,
  ) =>
    setHistory((current) =>
      record(
        current,
        typeof updater === 'function' ? updater(current.present) : updater,
        label,
      ),
    )

  function updateSection(key: string, patch: Partial<SectionDraft>) {
    // Labelled per section and per field group, so typing a title collapses to
    // one step but editing two different sections stays two.
    setSections(
      (current) => current.map((s) => (s.key === key ? { ...s, ...patch } : s)),
      `section:${key}:${Object.keys(patch).join(',')}`,
    )
  }

  function updateRule(sectionKey: string, ruleKey: string, patch: Partial<RuleDraft>) {
    setSections(
      (current) =>
        current.map((s) =>
          s.key === sectionKey
            ? { ...s, rules: s.rules.map((r) => (r.key === ruleKey ? { ...r, ...patch } : r)) }
            : s,
        ),
      `rule:${ruleKey}:${Object.keys(patch).join(',')}`,
    )
  }

  /** The buttons. Adjacent moves, and the same moveItem() a drag uses. */
  function moveSection(index: number, delta: number) {
    const target = index + delta
    if (target < 0 || target >= sections.length) return
    commit(moveItem(sections, index, target))
  }

  const sensors = useSensors(
    // A small distance threshold, so a click on a field inside a section is not
    // read as the start of a drag. Without it, editing becomes unreliable in
    // exactly the way that makes people stop trusting drag-and-drop.
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
  )

  function onDragEnd(event: DragEndEvent) {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const from = sections.findIndex((s) => s.key === active.id)
    const to = sections.findIndex((s) => s.key === over.id)
    if (from < 0 || to < 0) return
    commit(moveItem(sections, from, to))
  }

  /**
   * What the paper is worth, live.
   *
   * marksPerQuestion is nullable — null means "use the question's own marks",
   * which cannot be known until the draw happens. So this is a floor, not a
   * total, and the UI says so rather than printing a confident number that the
   * published paper then disagrees with.
   */
  const marks = sections.reduce(
    (acc, section) => {
      for (const rule of section.rules) {
        acc.questions += rule.questionCount
        if (rule.marksPerQuestion === null) acc.unknown += rule.questionCount
        else acc.known += rule.questionCount * rule.marksPerQuestion
      }
      return acc
    },
    { questions: 0, known: 0, unknown: 0 },
  )

  function save() {
    setError(null)
    startTransition(async () => {
      const result = await saveSections({
        examId,
        sections: sections.map((s) => ({
          title: s.title,
          instructions: s.instructions || null,
          rules: s.rules.map((r) => ({
            categoryId: r.categoryId,
            includeSubcategories: r.includeSubcategories,
            difficultyMin: r.difficultyMin,
            difficultyMax: r.difficultyMax,
            questionCount: r.questionCount,
            marksPerQuestion: r.marksPerQuestion,
          })),
        })),
      })

      if (!result.ok) {
        setError(result.error ?? 'Could not save.')
        return
      }
      toast.success(t('saved'))
      router.refresh()
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {error && (
          <InlineError>{error}</InlineError>
        )}

        {sections.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('none')}</p>
        )}

        <DndContext
          sensors={sensors}
          // Vertical only, and inside the list: a section dragged sideways or
          // out of the card has nowhere meaningful to land, and letting it try
          // just produces drops that silently do nothing.
          modifiers={[restrictToVerticalAxis, restrictToParentElement]}
          onDragEnd={onDragEnd}
        >
          <SortableContext
            items={sections.map((s) => s.key)}
            strategy={verticalListSortingStrategy}
          >
            <div className="space-y-4">
        {sections.map((section, index) => (
          <SortableRow key={section.key} id={section.key} disabled={disabled}>
          <div className="space-y-3 rounded-md border p-4">
            <div className="flex items-start gap-2">
              <div className="flex-1 space-y-2">
                <Label htmlFor={`section-${section.key}`}>{t('sectionTitle')}</Label>
                <Input
                  id={`section-${section.key}`}
                  value={section.title}
                  onChange={(e) => updateSection(section.key, { title: e.target.value })}
                  placeholder={t('sectionTitlePlaceholder')}
                  disabled={disabled}
                />
              </div>
              <div className="flex pt-7">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t('moveUp')}
                  disabled={disabled || index === 0}
                  onClick={() => moveSection(index, -1)}
                >
                  <ArrowUpIcon />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t('moveDown')}
                  disabled={disabled || index === sections.length - 1}
                  onClick={() => moveSection(index, 1)}
                >
                  <ArrowDownIcon />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={t('removeSection')}
                  disabled={disabled}
                  onClick={() =>
                    setSections((current) => current.filter((s) => s.key !== section.key))
                  }
                >
                  <XIcon />
                </Button>
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor={`section-instructions-${section.key}`}>{t('instructions')}</Label>
              <Textarea
                id={`section-instructions-${section.key}`}
                value={section.instructions}
                onChange={(e) => updateSection(section.key, { instructions: e.target.value })}
                rows={2}
                disabled={disabled}
              />
            </div>

            <div className="space-y-2">
              <Label>{t('rules')}</Label>
              {section.rules.length === 0 && (
                <p className="text-sm text-muted-foreground">{t('noRules')}</p>
              )}
              {section.rules.map((rule) => (
                <RuleRow
                  key={rule.key}
                  examId={examId}
                  rule={rule}
                  categories={categories}
                  count={rule.id ? counts.get(rule.id) : undefined}
                  disabled={disabled}
                  onChange={(patch) => updateRule(section.key, rule.key, patch)}
                  onRemove={() =>
                    updateSection(section.key, {
                      rules: section.rules.filter((r) => r.key !== rule.key),
                    })
                  }
                />
              ))}
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled}
                onClick={() =>
                  updateSection(section.key, {
                    rules: [
                      ...section.rules,
                      {
                        key: nextKey(),
                        categoryId: null,
                        includeSubcategories: true,
                        difficultyMin: 1,
                        difficultyMax: 5,
                        questionCount: 5,
                        marksPerQuestion: null,
                      },
                    ],
                  })
                }
              >
                <PlusIcon />
                {t('addRule')}
              </Button>
            </div>
          </div>
          </SortableRow>
        ))}
            </div>
          </SortableContext>
        </DndContext>

        {/*
         * What the paper is worth so far. A rule with no marks-per-question
         * takes each question's own marks, which is unknowable until the draw,
         * so this reports a floor and names the unknown part rather than
         * printing a confident total the published paper would contradict.
         */}
        {sections.length > 0 && (
          <p className="text-sm text-muted-foreground" aria-live="polite">
            {marks.unknown > 0
              ? t('marksPartial', {
                  questions: marks.questions,
                  known: marks.known,
                  unknown: marks.unknown,
                })
              : t('marksTotal', { questions: marks.questions, marks: marks.known })}
          </p>
        )}

        {!readOnly && (
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              onClick={() =>
                setSections((current) => [
                  ...current,
                  { key: nextKey(), title: '', instructions: '', rules: [] },
                ])
              }
            >
              <PlusIcon />
              {t('addSection')}
            </Button>
            {/*
             * Undo and redo are real buttons rather than only Ctrl+Z, because
             * this builder holds text inputs: inside one, Ctrl+Z belongs to the
             * browser's own text history, and stealing it would make typing
             * behave differently here than everywhere else on the web.
             */}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('undo')}
              title={t('undo')}
              disabled={disabled || !canUndo(history)}
              onClick={() => setHistory(undo)}
            >
              <Undo2Icon />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={t('redo')}
              title={t('redo')}
              disabled={disabled || !canRedo(history)}
              onClick={() => setHistory(redo)}
            >
              <Redo2Icon />
            </Button>
            <Button onClick={save} disabled={disabled}>
              {t('save')}
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function RuleRow({
  examId,
  rule,
  categories,
  count,
  disabled,
  onChange,
  onRemove,
}: {
  examId: string
  rule: RuleDraft
  categories: CategoryOption[]
  count?: RuleCount
  disabled: boolean
  onChange: (patch: Partial<RuleDraft>) => void
  onRemove: () => void
}) {
  const t = useTranslations('exams.sections')
  const [available, setAvailable] = useState<number | null>(count?.available ?? null)

  // Live count, debounced. Every keystroke on the difficulty inputs would
  // otherwise be a round trip; 300ms is long enough to stop typing and short
  // enough that the number feels attached to the control.
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(async () => {
      const n = await previewRuleCount({
        examId,
        categoryId: rule.categoryId,
        includeSubcategories: rule.includeSubcategories,
        tagIds: [],
        difficultyMin: rule.difficultyMin,
        difficultyMax: rule.difficultyMax,
      })
      if (!cancelled) setAvailable(n)
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [examId, rule.categoryId, rule.includeSubcategories, rule.difficultyMin, rule.difficultyMax])

  const short = available !== null && available < rule.questionCount
  const takenByEarlier =
    count && count.available > count.drawn ? count.available - count.drawn : 0

  const selectClass =
    'h-9 rounded-md border border-input bg-transparent px-2 text-sm disabled:opacity-50'

  return (
    <div className="space-y-2 rounded-md border p-3">
      <div className="flex flex-wrap items-end gap-2">
        <div className="min-w-48 flex-1 space-y-1">
          <Label className="text-xs">{t('category')}</Label>
          <select
            value={rule.categoryId ?? ''}
            onChange={(e) => onChange({ categoryId: e.target.value || null })}
            disabled={disabled}
            aria-label={t('category')}
            className={`${selectClass} w-full`}
          >
            <option value="">{t('anyCategory')}</option>
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.parent_id ? '— ' : ''}
                {category.name}
              </option>
            ))}
          </select>
        </div>

        <div className="w-20 space-y-1">
          <Label className="text-xs">{t('difficultyFrom')}</Label>
          <select
            value={rule.difficultyMin}
            onChange={(e) => onChange({ difficultyMin: Number(e.target.value) })}
            disabled={disabled}
            aria-label={t('difficultyFrom')}
            className={`${selectClass} w-full`}
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>

        <div className="w-20 space-y-1">
          <Label className="text-xs">{t('difficultyTo')}</Label>
          <select
            value={rule.difficultyMax}
            onChange={(e) => onChange({ difficultyMax: Number(e.target.value) })}
            disabled={disabled}
            aria-label={t('difficultyTo')}
            className={`${selectClass} w-full`}
          >
            {[1, 2, 3, 4, 5].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>

        <div className="w-24 space-y-1">
          <Label className="text-xs">{t('howMany')}</Label>
          <Input
            type="number"
            min={1}
            max={200}
            value={rule.questionCount}
            onChange={(e) => onChange({ questionCount: Number(e.target.value) || 1 })}
            disabled={disabled}
            aria-label={t('howMany')}
          />
        </div>

        <Button
          type="button"
          variant="ghost"
          size="icon"
          aria-label={t('removeRule')}
          disabled={disabled}
          onClick={onRemove}
        >
          <XIcon />
        </Button>
      </div>

      <div className="flex items-center gap-3">
        <Switch
          checked={rule.includeSubcategories}
          onCheckedChange={(checked) => onChange({ includeSubcategories: Boolean(checked) })}
          disabled={disabled}
          aria-label={t('includeSubcategories')}
        />
        <span className="text-sm text-muted-foreground">{t('includeSubcategories')}</span>
      </div>

      <p className={`text-sm ${short ? 'text-destructive' : 'text-muted-foreground'}`}>
        {available === null
          ? t('counting')
          : t('available', { available, wanted: rule.questionCount })}
        {/* Only meaningful once saved, because "what is left after the earlier
            rules" requires the real draw. */}
        {takenByEarlier > 0 && ` · ${t('takenByEarlier', { count: takenByEarlier })}`}
      </p>
    </div>
  )
}
