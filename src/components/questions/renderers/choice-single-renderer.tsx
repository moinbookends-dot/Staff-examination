'use client'

import type { AnswerPayload } from '@/lib/questions/schemas'
import type { FormatRendererProps, RenderableContent } from '../types'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'

type Content = Extract<RenderableContent, { format: 'choice_single' }>
type Answer = Extract<AnswerPayload, { format: 'choice_single' }>

/**
 * What the candidate sees.
 *
 * NOTE WHAT IS ABSENT: the answer key. Renderers receive content only, and this
 * is the component exam delivery will mount in M4 — so the correct answer is
 * never in the props, never in the payload the browser receives, and cannot be
 * read out of devtools. That is the whole reason keys live in a separate table.
 */
export default function ChoiceSingleRenderer({
  content,
  answer,
  onAnswerChange,
  readOnly,
}: FormatRendererProps) {
  const c = content as Content
  const a = answer as Answer

  return (
    <RadioGroup
      value={a.choice ?? ''}
      onValueChange={(value) => onAnswerChange?.({ format: 'choice_single', choice: String(value) })}
      disabled={readOnly || !onAnswerChange}
    >
      {c.choices.map((choice) => (
        <label
          key={choice.id}
          className="flex cursor-pointer items-start gap-3 rounded-md border p-3 text-sm has-data-checked:border-primary"
        >
          <RadioGroupItem value={choice.id} className="mt-0.5" />
          <span>{choice.text || <span className="text-muted-foreground">(empty option)</span>}</span>
        </label>
      ))}
      {c.choices.length === 0 && (
        <p className="text-sm text-muted-foreground">No options yet.</p>
      )}
    </RadioGroup>
  )
}
