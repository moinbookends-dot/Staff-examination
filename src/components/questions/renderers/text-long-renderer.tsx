'use client'

import type { AnswerPayload } from '@/lib/questions/schemas'
import type { FormatRendererProps, RenderableContent } from '../types'
import { Textarea } from '@/components/ui/textarea'

type Content = Extract<RenderableContent, { format: 'text_long' }>
type Answer = Extract<AnswerPayload, { format: 'text_long' }>

/** Whitespace-split. Good enough for a limit; not a metric anything scores on. */
function countWords(text: string): number {
  const trimmed = text.trim()
  return trimmed ? trimmed.split(/\s+/).length : 0
}

export default function TextLongRenderer({
  content,
  answer,
  onAnswerChange,
  readOnly,
}: FormatRendererProps) {
  const c = content as Content
  const a = answer as Answer
  const words = countWords(a.text)
  const over = words > c.maxWords

  return (
    <div className="space-y-1">
      <Textarea
        value={a.text}
        // NOT capped with maxLength, unlike short answer. A word limit cannot be
        // enforced by a character count, and truncating mid-sentence as someone
        // types is worse than letting them run over and see it.
        onChange={(e) => onAnswerChange?.({ format: 'text_long', text: e.target.value })}
        disabled={readOnly || !onAnswerChange}
        rows={10}
        aria-label="Your answer"
      />
      <p className={`text-right text-xs ${over ? 'text-destructive' : 'text-muted-foreground'}`}>
        {words} / {c.maxWords} words
      </p>
    </div>
  )
}
