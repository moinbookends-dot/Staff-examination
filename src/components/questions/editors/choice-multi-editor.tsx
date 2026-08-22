'use client'

import type { AnswerKey, QuestionContentDraft } from '@/lib/questions/schemas'
import type { FormatEditorProps } from '../types'
import { OptionListEditor, type EditableItem } from '../shared/option-list-editor'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'

type Content = Extract<QuestionContentDraft, { format: 'choice_multi' }>
type Key = Extract<AnswerKey, { format: 'choice_multi' }>

export default function ChoiceMultiEditor({
  content,
  answerKey,
  onChange,
  disabled,
}: FormatEditorProps) {
  const c = content as Content
  const k = answerKey as Key
  const correct = new Set(k.correct)

  function setChoices(choices: EditableItem[]) {
    const ids = new Set(choices.map((choice) => choice.id))
    onChange({
      content: { ...c, choices },
      answerKey: { ...k, correct: k.correct.filter((id) => ids.has(id)) },
    })
  }

  function toggle(id: string, checked: boolean) {
    const next = checked ? [...k.correct, id] : k.correct.filter((x) => x !== id)
    onChange({ content: c, answerKey: { ...k, correct: next } })
  }

  const allCorrect = c.choices.length > 0 && correct.size === c.choices.length

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <Label>Options — tick every correct one</Label>
        <OptionListEditor
          items={c.choices}
          onChange={setChoices}
          min={2}
          max={8}
          disabled={disabled}
          renderLead={(item) => (
            <Checkbox
              checked={correct.has(item.id)}
              onCheckedChange={(checked) => toggle(item.id, Boolean(checked))}
              disabled={disabled}
              aria-label={`Mark ${item.id} correct`}
            />
          )}
        />
        {allCorrect && (
          // validateQuestion() blocks publishing on this, but saying so here
          // saves the chef discovering it after writing eight options.
          <p className="text-sm text-destructive">
            Every option is marked correct — the question cannot tell anyone apart.
          </p>
        )}
      </div>

      <div className="flex items-start gap-3 rounded-md border p-3">
        <Switch
          checked={k.partialCredit}
          onCheckedChange={(checked) =>
            onChange({ content: c, answerKey: { ...k, partialCredit: Boolean(checked) } })
          }
          disabled={disabled}
          aria-label="Partial credit"
        />
        <div className="space-y-0.5">
          <Label>Partial credit</Label>
          <p className="text-sm text-muted-foreground">
            Score the proportion picked correctly, minus wrong picks. Turn it off and the
            question is all-or-nothing.
          </p>
        </div>
      </div>
    </div>
  )
}
