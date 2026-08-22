'use client'

import type { AnswerPayload } from '@/lib/questions/schemas'
import type { FormatRendererProps } from '../types'
import { Textarea } from '@/components/ui/textarea'
import { ClipboardCheckIcon } from 'lucide-react'

type Answer = Extract<AnswerPayload, { format: 'evaluator_only' }>

/**
 * Practical and viva, from the candidate's side.
 *
 * There is nothing to answer: a chef watches and scores. What the candidate
 * gets is the fact that this is assessed in person, which matters — an
 * otherwise-blank question with a Next button reads as broken, and someone will
 * refresh the page mid-exam trying to fix it.
 *
 * `content.instructions` is deliberately NOT rendered: it is the assessor's
 * setup — what to provide, what to watch for — and showing it would hand the
 * candidate the marking scheme.
 */
export default function EvaluatorOnlyRenderer({
  answer,
  onAnswerChange,
  readOnly,
}: FormatRendererProps) {
  const a = answer as Answer

  return (
    <div className="space-y-3">
      <div className="flex items-start gap-3 rounded-md border border-dashed p-4 text-sm text-muted-foreground">
        <ClipboardCheckIcon className="mt-0.5 size-4 shrink-0" />
        <p>
          Assessed in person. A chef will observe and score this — there is nothing to type
          here.
        </p>
      </div>

      <Textarea
        value={a.note ?? ''}
        onChange={(e) =>
          onAnswerChange?.({ format: 'evaluator_only', note: e.target.value, attachments: a.attachments })
        }
        disabled={readOnly || !onAnswerChange}
        rows={3}
        placeholder="Anything you want the assessor to know (optional)"
        aria-label="Note for the assessor"
      />
    </div>
  )
}
