'use client'

import type { AnswerPayload } from '@/lib/questions/schemas'
import type { FormatRendererProps, RenderableContent } from '../types'
import { Textarea } from '@/components/ui/textarea'

type Content = Extract<RenderableContent, { format: 'text_short' }>
type Answer = Extract<AnswerPayload, { format: 'text_short' }>

export default function TextShortRenderer({
  content,
  answer,
  onAnswerChange,
  readOnly,
}: FormatRendererProps) {
  const c = content as Content
  const a = answer as Answer
  const remaining = c.maxChars - a.text.length

  return (
    <div className="space-y-1">
      <Textarea
        value={a.text}
        // maxLength rather than validation-on-submit: a candidate who writes
        // 400 characters and is then told the limit was 300 has to cut their
        // own answer down under exam time pressure.
        maxLength={c.maxChars}
        onChange={(e) => onAnswerChange?.({ format: 'text_short', text: e.target.value })}
        disabled={readOnly || !onAnswerChange}
        rows={3}
        aria-label="Your answer"
      />
      <p className="text-right text-xs text-muted-foreground">
        {remaining} characters left
      </p>
    </div>
  )
}
