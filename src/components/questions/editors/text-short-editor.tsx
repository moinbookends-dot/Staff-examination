'use client'

import type { AnswerKey, QuestionContentDraft } from '@/lib/questions/schemas'
import type { FormatEditorProps } from '../types'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'

type Content = Extract<QuestionContentDraft, { format: 'text_short' }>
type Key = Extract<AnswerKey, { format: 'text_short' }>

/**
 * Short answer — a sentence or three, graded by a human.
 *
 * The model answer and keywords are HINTS FOR THE EVALUATOR, never auto-scored.
 * Keyword matching reads as objective and is not: "do not reuse the board"
 * contains none of the keywords for a question about cross-contamination and is
 * completely correct, while "wash the board and reuse it" contains two and is
 * dangerous. grading.ts returns needs_review for this format for that reason.
 */
export default function TextShortEditor({
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
        <Label htmlFor="short-max">Character limit</Label>
        <Input
          id="short-max"
          type="number"
          min={10}
          max={2000}
          className="w-32"
          value={c.maxChars}
          onChange={(e) =>
            onChange({
              content: { ...c, maxChars: Number(e.target.value) || 300 },
              answerKey: k,
            })
          }
          disabled={disabled}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="short-model">Model answer</Label>
        <Textarea
          id="short-model"
          value={k.modelAnswer ?? ''}
          onChange={(e) =>
            onChange({
              content: c,
              answerKey: { ...k, modelAnswer: e.target.value || undefined },
            })
          }
          placeholder="What a full-marks answer says. Shown to the evaluator, never to the candidate before submission."
          rows={3}
          disabled={disabled}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="short-keywords">Keywords</Label>
        <Input
          id="short-keywords"
          value={k.keywords.join(', ')}
          onChange={(e) =>
            onChange({
              content: c,
              answerKey: {
                ...k,
                keywords: e.target.value.split(',').map((s) => s.trim()).filter(Boolean),
              },
            })
          }
          placeholder="separate boards, wash hands, sanitise"
          disabled={disabled}
        />
        <p className="text-sm text-muted-foreground">
          Highlighted for the evaluator as a prompt. They are never scored automatically — a
          right answer using different words would fail, and a wrong one using the right words
          would pass.
        </p>
      </div>
    </div>
  )
}
