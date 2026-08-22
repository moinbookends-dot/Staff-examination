'use client'

import type { AnswerKey, QuestionContentDraft } from '@/lib/questions/schemas'
import type { FormatEditorProps } from '../types'
import { OptionListEditor, type EditableItem } from '../shared/option-list-editor'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import { Label } from '@/components/ui/label'

type Content = Extract<QuestionContentDraft, { format: 'choice_single' }>
type Key = Extract<AnswerKey, { format: 'choice_single' }>

/**
 * Single-answer multiple choice.
 *
 * The correct answer is a radio in the option row rather than a separate
 * dropdown of ids. A dropdown means reading "c" and mentally mapping it back to
 * the option — the step where a chef picks the wrong letter and nothing catches
 * it, because a key naming a real-but-wrong option is perfectly valid.
 */
export default function ChoiceSingleEditor({
  content,
  answerKey,
  onChange,
  disabled,
}: FormatEditorProps) {
  const c = content as Content
  const k = answerKey as Key

  function setChoices(choices: EditableItem[]) {
    // Deleting the correct option must clear the key in the SAME commit, or the
    // key points at an id that no longer exists — valid to both schemas, and
    // silently wrong for every candidate.
    const ids = new Set(choices.map((choice) => choice.id))
    onChange({
      content: { ...c, choices },
      answerKey: { ...k, correct: ids.has(k.correct) ? k.correct : (choices[0]?.id ?? '') },
    })
  }

  return (
    <div className="space-y-3">
      <Label>Options — select the correct one</Label>

      <RadioGroup
        value={k.correct}
        onValueChange={(value) => onChange({ content: c, answerKey: { ...k, correct: String(value) } })}
        disabled={disabled}
        className="gap-2"
      >
        <OptionListEditor
          items={c.choices}
          onChange={setChoices}
          min={2}
          max={6}
          disabled={disabled}
          renderLead={(item) => (
            <RadioGroupItem value={item.id} aria-label={`Mark ${item.id} correct`} />
          )}
        />
      </RadioGroup>
    </div>
  )
}
