'use client'

import type { AnswerPayload } from '@/lib/questions/schemas'
import type { FormatRendererProps, RenderableContent } from '../types'
import { Button } from '@/components/ui/button'
import { ArrowDownIcon, ArrowUpIcon } from 'lucide-react'

type Content = Extract<RenderableContent, { format: 'order' }>
type Answer = Extract<AnswerPayload, { format: 'order' }>

/**
 * Sequencing, arranged with buttons.
 *
 * Same reasoning as the editor's list control: no dnd library, and dragging
 * inside a scrolling page on a phone fights the scroll. Buttons also give this
 * a keyboard path for free, which a drag implementation would have to add
 * separately and usually does not.
 *
 * SHUFFLING IS NOT DONE HERE. The answer's `order` is whatever arrangement the
 * candidate is looking at, and M4's exam delivery seeds it with a shuffle at
 * the start of the attempt. If the renderer shuffled, it would reshuffle on
 * every re-render and the candidate's work would evaporate as they typed.
 */
export default function OrderRenderer({
  content,
  answer,
  onAnswerChange,
  readOnly,
}: FormatRendererProps) {
  const c = content as Content
  const a = answer as Answer
  const disabled = readOnly || !onAnswerChange

  const byId = new Map(c.items.map((item) => [item.id, item]))
  // Fall back to content order when the candidate has not started. Unknown ids
  // (an item deleted after the attempt began) are dropped rather than rendered
  // as a blank row.
  const ordered = (a.order.length ? a.order : c.items.map((item) => item.id)).filter((id) =>
    byId.has(id),
  )

  function move(index: number, delta: number) {
    const target = index + delta
    if (target < 0 || target >= ordered.length) return
    const next = [...ordered]
    ;[next[index], next[target]] = [next[target], next[index]]
    onAnswerChange?.({ format: 'order', order: next })
  }

  if (ordered.length === 0) {
    return <p className="text-sm text-muted-foreground">Nothing to put in order yet.</p>
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">Put these in the correct order.</p>
      {ordered.map((id, index) => (
        <div key={id} className="flex items-center gap-2 rounded-md border p-3">
          <span className="w-6 shrink-0 text-center text-sm text-muted-foreground">
            {index + 1}
          </span>
          <span className="min-w-0 flex-1 text-sm">{byId.get(id)?.text || id}</span>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Move ${byId.get(id)?.text || id} up`}
            disabled={disabled || index === 0}
            onClick={() => move(index, -1)}
          >
            <ArrowUpIcon />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label={`Move ${byId.get(id)?.text || id} down`}
            disabled={disabled || index === ordered.length - 1}
            onClick={() => move(index, 1)}
          >
            <ArrowDownIcon />
          </Button>
        </div>
      ))}
    </div>
  )
}
