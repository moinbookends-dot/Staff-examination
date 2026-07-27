'use client'

import type { AnswerKey, QuestionContentDraft } from '@/lib/questions/schemas'
import type { FormatEditorProps } from '../types'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { RubricEditor } from '../shared/rubric-editor'

type Content = Extract<QuestionContentDraft, { format: 'text_long' }>
type Key = Extract<AnswerKey, { format: 'text_long' }>

/** Essay. Rubric optional here, unlike a practical, where it is the only key. */
export default function TextLongEditor({
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
        <Label htmlFor="long-max">Word limit</Label>
        <Input
          id="long-max"
          type="number"
          min={20}
          max={2000}
          className="w-32"
          value={c.maxWords}
          onChange={(e) =>
            onChange({ content: { ...c, maxWords: Number(e.target.value) || 500 }, answerKey: k })
          }
          disabled={disabled}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="long-model">Model answer</Label>
        <Textarea
          id="long-model"
          value={k.modelAnswer ?? ''}
          onChange={(e) =>
            onChange({ content: c, answerKey: { ...k, modelAnswer: e.target.value || undefined } })
          }
          placeholder="What a full-marks answer covers."
          rows={5}
          disabled={disabled}
        />
      </div>

      <div className="space-y-2">
        <Label>Marking rubric</Label>
        <p className="text-sm text-muted-foreground">
          Optional, but two chefs verifying the same essay without one will disagree and have
          nothing to appeal to.
        </p>
        <RubricEditor
          rubric={k.rubric}
          onChange={(rubric) => onChange({ content: c, answerKey: { ...k, rubric } })}
          disabled={disabled}
        />
      </div>
    </div>
  )
}
