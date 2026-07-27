'use client'

import type { AnswerKey, QuestionContentDraft } from '@/lib/questions/schemas'
import type { FormatEditorProps } from '../types'
import { OptionListEditor, type EditableItem } from '../shared/option-list-editor'
import { Label } from '@/components/ui/label'

type Content = Extract<QuestionContentDraft, { format: 'order' }>
type Key = Extract<AnswerKey, { format: 'order' }>

const SCORING: { value: Key['scoring']; label: string; hint: string }[] = [
  { value: 'exact', label: 'Exact order', hint: 'All or nothing. The whole sequence must match.' },
  {
    value: 'adjacent',
    label: 'Credit per correct pair',
    hint: 'Getting steps 1–2 right is worth something even if 5 and 6 are swapped. Suits recipes and procedures.',
  },
  {
    value: 'kendall',
    label: 'Rank correlation',
    hint: 'Scores how close the whole ordering is. Harsher on a single item moved a long way.',
  },
]

/**
 * Sequencing.
 *
 * THE ORDER TYPED IN IS THE CORRECT ORDER. There is no separate "now set the
 * answer" step: a chef writes the steps of a procedure in the order they happen,
 * and the exam shuffles them at delivery. Asking someone to author a scrambled
 * list and then unscramble it in a second control is work that exists only to
 * satisfy the data model, and it is where the mistakes come from.
 *
 * The CSV importer already defaults to this. Same rule, both paths.
 */
export default function OrderEditor({
  content,
  answerKey,
  onChange,
  disabled,
}: FormatEditorProps) {
  const c = content as Content
  const k = answerKey as Key

  function setItems(items: EditableItem[]) {
    onChange({
      content: { ...c, items },
      answerKey: { ...k, correct: items.map((item) => item.id) },
    })
  }

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <Label>Steps, in the correct order</Label>
        <OptionListEditor
          items={c.items}
          onChange={setItems}
          min={2}
          max={12}
          idPrefix="s"
          disabled={disabled}
          placeholder="Step"
          addLabel="Add step"
          emptyHint="Add the steps in the order they should happen. The exam shuffles them."
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="order-scoring">How to score a wrong order</Label>
        <select
          id="order-scoring"
          value={k.scoring}
          onChange={(e) =>
            onChange({ content: c, answerKey: { ...k, scoring: e.target.value as Key['scoring'] } })
          }
          disabled={disabled}
          className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
        >
          {SCORING.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <p className="text-sm text-muted-foreground">
          {SCORING.find((s) => s.value === k.scoring)?.hint}
        </p>
      </div>
    </div>
  )
}
