'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from '@/lib/i18n/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { saveSections, previewRuleCount, type RuleCount } from '@/server/actions/exams'
import type { CategoryOption } from '@/server/actions/questions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { ArrowDownIcon, ArrowUpIcon, PlusIcon, XIcon } from 'lucide-react'

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
  const [sections, setSections] = useState<SectionDraft[]>(initialSections)
  const [error, setError] = useState<string | null>(null)

  const counts = new Map(ruleCounts.map((c) => [c.rule_id, c]))
  const disabled = pending || Boolean(readOnly)

  function updateSection(key: string, patch: Partial<SectionDraft>) {
    setSections((current) => current.map((s) => (s.key === key ? { ...s, ...patch } : s)))
  }

  function updateRule(sectionKey: string, ruleKey: string, patch: Partial<RuleDraft>) {
    setSections((current) =>
      current.map((s) =>
        s.key === sectionKey
          ? { ...s, rules: s.rules.map((r) => (r.key === ruleKey ? { ...r, ...patch } : r)) }
          : s,
      ),
    )
  }

  function moveSection(index: number, delta: number) {
    const target = index + delta
    if (target < 0 || target >= sections.length) return
    const next = [...sections]
    ;[next[index], next[target]] = [next[target], next[index]]
    setSections(next)
  }

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
          <p className="rounded-md border border-destructive p-3 text-sm text-destructive">
            {error}
          </p>
        )}

        {sections.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('none')}</p>
        )}

        {sections.map((section, index) => (
          <div key={section.key} className="space-y-3 rounded-md border p-4">
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
        ))}

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
