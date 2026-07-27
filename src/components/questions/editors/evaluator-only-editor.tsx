'use client'

import type { AnswerKey, QuestionContentDraft } from '@/lib/questions/schemas'
import type { FormatEditorProps } from '../types'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { RubricEditor } from '../shared/rubric-editor'

type Content = Extract<QuestionContentDraft, { format: 'evaluator_only' }>
type Key = Extract<AnswerKey, { format: 'evaluator_only' }>

/**
 * Practical and viva.
 *
 * The candidate types nothing: a chef watches them break down a fish and scores
 * what they saw. So the rubric IS the answer key — it is the only record of what
 * was being judged, and the only thing a dual-verification disagreement can be
 * settled against. Hence the minimum of one criterion, enforced by the schema
 * and reflected here in a delete button that will not remove the last row.
 */
export default function EvaluatorOnlyEditor({
  content,
  answerKey,
  onChange,
  disabled,
}: FormatEditorProps) {
  const c = content as Content
  const k = answerKey as Key

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="practical-instructions">Instructions for the assessor</Label>
        <Textarea
          id="practical-instructions"
          value={c.instructions ?? ''}
          onChange={(e) =>
            onChange({
              content: { ...c, instructions: e.target.value || undefined },
              answerKey: k,
            })
          }
          placeholder="Observe the candidate breaking down a whole fish. Provide a 2 kg sea bass and a filleting knife."
          rows={4}
          disabled={disabled}
        />
        <p className="text-sm text-muted-foreground">
          Setup, materials and what to watch for. The candidate never sees this.
        </p>
      </div>

      <div className="space-y-2">
        <Label>Marking rubric</Label>
        <RubricEditor
          rubric={k.rubric}
          onChange={(rubric) => onChange({ content: c, answerKey: { ...k, rubric } })}
          disabled={disabled}
          min={1}
        />
      </div>
    </div>
  )
}
