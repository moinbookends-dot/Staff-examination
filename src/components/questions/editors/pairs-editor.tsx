'use client'

import type { AnswerKey, QuestionContentDraft } from '@/lib/questions/schemas'
import type { FormatEditorProps } from '../types'
import { OptionListEditor, type EditableItem } from '../shared/option-list-editor'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

type Content = Extract<QuestionContentDraft, { format: 'pairs' }>
type Key = Extract<AnswerKey, { format: 'pairs' }>

/**
 * Match the following.
 *
 * The pairing is set from a dropdown on each LEFT row rather than by drawing
 * lines: a left item has exactly one match, so a select expresses the constraint
 * directly and cannot produce a left item matched twice.
 *
 * DISTRACTORS are surfaced as a switch because without them matching degrades
 * into elimination — with equal columns the last pair is free, so a candidate
 * who knows n−1 answers scores n. validateQuestion() requires equal columns
 * unless the switch is on, which is what makes the mismatch a deliberate choice
 * rather than a miscount.
 */
export default function PairsEditor({
  content,
  answerKey,
  onChange,
  disabled,
}: FormatEditorProps) {
  const c = content as Content
  const k = answerKey as Key

  function setLeft(left: EditableItem[]) {
    const ids = new Set(left.map((item) => item.id))
    const correct = Object.fromEntries(
      Object.entries(k.correct).filter(([leftId]) => ids.has(leftId)),
    )
    onChange({ content: { ...c, left }, answerKey: { ...k, correct } })
  }

  function setRight(right: EditableItem[]) {
    const ids = new Set(right.map((item) => item.id))
    // Drop pairings whose right-hand item is gone, keeping the left item so the
    // chef can re-point it rather than losing the row.
    const correct = Object.fromEntries(
      Object.entries(k.correct).filter(([, rightId]) => ids.has(rightId)),
    )
    onChange({
      content: { ...c, right, hasDistractors: right.length > c.left.length },
      answerKey: { ...k, correct },
    })
  }

  function pair(leftId: string, rightId: string) {
    const correct = { ...k.correct }
    if (rightId) correct[leftId] = rightId
    else delete correct[leftId]
    onChange({ content: c, answerKey: { ...k, correct } })
  }

  const unmatched = c.left.filter((item) => !k.correct[item.id])

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <Label>Left column</Label>
          <OptionListEditor
            items={c.left}
            onChange={setLeft}
            min={2}
            max={10}
            idPrefix="l"
            disabled={disabled}
            placeholder="Item"
            addLabel="Add left item"
          />
        </div>

        <div className="space-y-3">
          <Label>Right column</Label>
          <OptionListEditor
            items={c.right}
            onChange={setRight}
            min={2}
            max={12}
            idPrefix="r"
            disabled={disabled}
            placeholder="Match"
            addLabel="Add right item"
          />
        </div>
      </div>

      <div className="space-y-3">
        <Label>Correct pairings</Label>
        {c.left.length === 0 ? (
          <p className="text-sm text-muted-foreground">Add left-hand items first.</p>
        ) : (
          c.left.map((item) => (
            <div key={item.id} className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm">
                <span className="font-mono text-xs text-muted-foreground">{item.id}</span>{' '}
                {item.text || <span className="text-muted-foreground">(no text yet)</span>}
              </span>
              <span className="text-muted-foreground">→</span>
              <select
                value={k.correct[item.id] ?? ''}
                onChange={(e) => pair(item.id, e.target.value)}
                disabled={disabled}
                aria-label={`Match for ${item.id}`}
                className="h-9 min-w-40 flex-1 rounded-md border border-input bg-transparent px-2 text-sm"
              >
                <option value="">Not matched</option>
                {c.right.map((right) => (
                  <option key={right.id} value={right.id}>
                    {right.text || right.id}
                  </option>
                ))}
              </select>
            </div>
          ))
        )}
        {unmatched.length > 0 && (
          <p className="text-sm text-destructive">
            {unmatched.length} left item{unmatched.length === 1 ? '' : 's'} still unmatched.
          </p>
        )}
      </div>

      <div className="flex items-start gap-3 rounded-md border p-3">
        <Switch
          checked={c.hasDistractors}
          onCheckedChange={(checked) =>
            onChange({ content: { ...c, hasDistractors: Boolean(checked) }, answerKey: k })
          }
          disabled={disabled}
          aria-label="Distractors"
        />
        <div className="space-y-0.5">
          <Label>The right column has extras</Label>
          <p className="text-sm text-muted-foreground">
            Unmatched right-hand items stop the last pair being free. Required if the columns
            are different lengths.
          </p>
        </div>
      </div>

      <div className="flex items-start gap-3 rounded-md border p-3">
        <Switch
          checked={k.partialCredit}
          onCheckedChange={(checked) =>
            onChange({ content: c, answerKey: { ...k, partialCredit: Boolean(checked) } })
          }
          disabled={disabled}
          aria-label="Partial credit"
        />
        <div className="space-y-0.5">
          <Label>Partial credit</Label>
          <p className="text-sm text-muted-foreground">Score each correct pairing separately.</p>
        </div>
      </div>
    </div>
  )
}
