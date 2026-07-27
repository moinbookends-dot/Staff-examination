'use client'

import type { AnswerPayload } from '@/lib/questions/schemas'
import type { FormatRendererProps, RenderableContent } from '../types'
import { Checkbox } from '@/components/ui/checkbox'

type Content = Extract<RenderableContent, { format: 'choice_multi' }>
type Answer = Extract<AnswerPayload, { format: 'choice_multi' }>

export default function ChoiceMultiRenderer({
  content,
  answer,
  onAnswerChange,
  readOnly,
}: FormatRendererProps) {
  const c = content as Content
  const a = answer as Answer
  const picked = new Set(a.choices)
  const disabled = readOnly || !onAnswerChange

  function toggle(id: string, checked: boolean) {
    // Rebuilt from the content order rather than by appending, so the stored
    // answer is stable regardless of the order the candidate ticked things.
    // Nothing in grading depends on it, but a stable payload makes an attempt
    // diffable and a replay reproducible.
    const next = new Set(picked)
    if (checked) next.add(id)
    else next.delete(id)
    onAnswerChange?.({
      format: 'choice_multi',
      choices: c.choices.map((choice) => choice.id).filter((id) => next.has(id)),
    })
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">Select all that apply.</p>
      {c.choices.map((choice) => (
        <label
          key={choice.id}
          className="flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm has-data-checked:border-primary"
        >
          <Checkbox
            checked={picked.has(choice.id)}
            onCheckedChange={(checked) => toggle(choice.id, Boolean(checked))}
            disabled={disabled}
            className="mt-0.5"
          />
          <span>{choice.text || <span className="text-muted-foreground">(empty option)</span>}</span>
        </label>
      ))}
      {c.choices.length === 0 && <p className="text-sm text-muted-foreground">No options yet.</p>}
    </div>
  )
}
