'use client'

import { Fragment } from 'react'
import type { AnswerPayload } from '@/lib/questions/schemas'
import type { FormatRendererProps, RenderableContent } from '../types'
import { Input } from '@/components/ui/input'

type Content = Extract<RenderableContent, { format: 'blanks' }>
type Answer = Extract<AnswerPayload, { format: 'blanks' }>

const PLACEHOLDER = /\{\{([a-zA-Z0-9_-]+)\}\}/g

/**
 * The sentence with inputs where the placeholders were.
 *
 * Rendered INLINE rather than as the sentence followed by a numbered list of
 * boxes: the surrounding words are the context that makes the blank answerable,
 * and separating them turns a comprehension question into a memory one.
 *
 * The inputs carry no `inputMode` or IME hints on purpose — this is where a
 * candidate types Devanagari or Gujarati, and forcing a numeric keypad because
 * most answers happen to be temperatures would make those unanswerable.
 */
export default function BlanksRenderer({
  content,
  answer,
  onAnswerChange,
  readOnly,
}: FormatRendererProps) {
  const c = content as Content
  const a = answer as Answer
  const disabled = readOnly || !onAnswerChange

  const segments: { text: string; blankId?: string }[] = []
  let cursor = 0
  for (const match of c.template.matchAll(PLACEHOLDER)) {
    const index = match.index ?? 0
    if (index > cursor) segments.push({ text: c.template.slice(cursor, index) })
    segments.push({ text: '', blankId: match[1] })
    cursor = index + match[0].length
  }
  if (cursor < c.template.length) segments.push({ text: c.template.slice(cursor) })

  if (segments.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing to fill in yet.</p>
  }

  return (
    <p className="flex flex-wrap items-baseline gap-x-1 gap-y-2 text-sm leading-8">
      {segments.map((segment, index) =>
        segment.blankId ? (
          <Input
            key={`${segment.blankId}-${index}`}
            value={a.values[segment.blankId] ?? ''}
            onChange={(e) =>
              onAnswerChange?.({
                format: 'blanks',
                values: { ...a.values, [segment.blankId!]: e.target.value },
              })
            }
            disabled={disabled}
            aria-label={`Blank ${segment.blankId}`}
            className="inline-block h-8 w-32 align-baseline"
          />
        ) : (
          <Fragment key={index}>{segment.text}</Fragment>
        ),
      )}
    </p>
  )
}
