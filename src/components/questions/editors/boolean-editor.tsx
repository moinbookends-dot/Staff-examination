'use client'

import type { AnswerKey, QuestionContentDraft } from '@/lib/questions/schemas'
import type { FormatEditorProps } from '../types'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'

type Content = Extract<QuestionContentDraft, { format: 'boolean' }>
type Key = Extract<AnswerKey, { format: 'boolean' }>

/**
 * True/false. The content payload is empty — the two options are implied — so
 * this editor sets only the key.
 *
 * It exists rather than being special-cased in the form because the registry's
 * contract is that every format has an editor. One format opting out is how
 * "add a format in one place" quietly stops being true.
 */
export default function BooleanEditor({
  content,
  answerKey,
  onChange,
  disabled,
}: FormatEditorProps) {
  const c = content as Content
  const k = answerKey as Key

  return (
    <div className="space-y-3">
      <Label>Which is correct?</Label>
      <RadioGroup
        value={k.correct ? 'true' : 'false'}
        onValueChange={(value) =>
          onChange({ content: c, answerKey: { ...k, correct: value === 'true' } })
        }
        disabled={disabled}
      >
        <label className="flex items-center gap-2 text-sm">
          <RadioGroupItem value="true" /> True
        </label>
        <label className="flex items-center gap-2 text-sm">
          <RadioGroupItem value="false" /> False
        </label>
      </RadioGroup>
      <p className="text-sm text-muted-foreground">
        The statement itself goes in the question text above.
      </p>
    </div>
  )
}
