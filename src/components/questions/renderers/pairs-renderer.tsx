'use client'

import type { AnswerPayload } from '@/lib/questions/schemas'
import type { FormatRendererProps, RenderableContent } from '../types'

type Content = Extract<RenderableContent, { format: 'pairs' }>
type Answer = Extract<AnswerPayload, { format: 'pairs' }>

/**
 * Match the following, as a select per left-hand row.
 *
 * Not lines drawn between two columns: that needs pointer precision, a canvas
 * layer and a keyboard fallback nobody builds, and it is unusable on the phone
 * most of this platform's candidates will answer on. A select is the same
 * information, works with a screen reader, and cannot express an invalid
 * pairing.
 */
export default function PairsRenderer({
  content,
  answer,
  onAnswerChange,
  readOnly,
}: FormatRendererProps) {
  const c = content as Content
  const a = answer as Answer
  const disabled = readOnly || !onAnswerChange

  function choose(leftId: string, rightId: string) {
    const mapping = { ...a.mapping }
    if (rightId) mapping[leftId] = rightId
    else delete mapping[leftId]
    onAnswerChange?.({ format: 'pairs', mapping })
  }

  if (c.left.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing to match yet.</p>
  }

  return (
    <div className="space-y-2">
      {c.left.map((item) => (
        <div key={item.id} className="flex items-center gap-2 rounded-md border p-3">
          <span className="min-w-0 flex-1 truncate text-sm">{item.text || item.id}</span>
          <span className="text-muted-foreground">→</span>
          <select
            value={a.mapping[item.id] ?? ''}
            onChange={(e) => choose(item.id, e.target.value)}
            disabled={disabled}
            aria-label={`Match for ${item.text || item.id}`}
            className="h-9 min-w-40 flex-1 rounded-md border border-input bg-transparent px-2 text-sm"
          >
            <option value="">Choose…</option>
            {c.right.map((right) => (
              <option key={right.id} value={right.id}>
                {right.text || right.id}
              </option>
            ))}
          </select>
        </div>
      ))}
    </div>
  )
}
