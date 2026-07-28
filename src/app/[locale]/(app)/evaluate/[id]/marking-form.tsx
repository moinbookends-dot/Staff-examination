'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { EvaluationItem } from '@/server/actions/evaluation'
import { saveEvaluation, completeEvaluation } from '@/server/actions/evaluation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { CheckIcon, AlertTriangleIcon } from 'lucide-react'

/**
 * Marking one paper.
 *
 * The evaluator sees the rubric because 0028 hands it over — under four
 * conditions at once, and only for questions a machine could not mark. What
 * they never see is the key for a multiple-choice question, which the grader
 * already settled.
 *
 * Every bound is the database's. The score input has no max attribute worth
 * trusting; save_evaluation() refuses anything above the question's marks, and
 * complete_evaluation() refuses while anything is unmarked. This component
 * reports those refusals rather than trying to prevent them, so the rule has
 * one home.
 */
export function MarkingForm({
  attemptId,
  items,
}: {
  attemptId: string
  items: EvaluationItem[]
}) {
  const t = useTranslations('evaluation')
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  const [marks, setMarks] = useState<Record<string, string>>(() =>
    Object.fromEntries(items.map((i) => [i.question_id, i.score != null ? String(i.score) : ''])),
  )
  const [notes, setNotes] = useState<Record<string, string>>(() =>
    Object.fromEntries(items.map((i) => [i.question_id, i.grader_note ?? ''])),
  )
  const [savedIds, setSavedIds] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  function save(questionId: string) {
    setError(null)
    startTransition(async () => {
      const result = await saveEvaluation({
        attemptId,
        questionId,
        score: marks[questionId],
        note: notes[questionId] || undefined,
      })
      if (result.ok) {
        setSavedIds((prev) => new Set(prev).add(questionId))
      } else {
        setError(result.error)
      }
    })
  }

  function finish() {
    setError(null)
    startTransition(async () => {
      const result = await completeEvaluation(attemptId)
      if (result.ok) {
        router.push('/evaluate')
      } else {
        setError(result.error)
      }
    })
  }

  return (
    <div className="space-y-4">
      {items.map((item) => {
        const guidance = item.guidance
        return (
          <Card key={item.question_id}>
            <CardHeader className="gap-2">
              <div className="flex items-start justify-between gap-3">
                <CardTitle className="text-base leading-relaxed">
                  {t('question', { position: item.paper_position + 1 })} — {item.stem}
                </CardTitle>
                <Badge variant="secondary" className="shrink-0">
                  {t('outOf', { marks: item.marks })}
                </Badge>
              </div>
              {item.auto_grade_status === 'needs_review' && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <AlertTriangleIcon className="size-3.5" />
                  {t('autoFlagged')}
                </p>
              )}
            </CardHeader>

            <CardContent className="space-y-4">
              <div>
                <p className="mb-1 text-xs font-medium text-muted-foreground">{t('answerGiven')}</p>
                <div className="rounded-md border bg-muted/30 p-3 text-sm whitespace-pre-wrap">
                  {renderAnswer(item) || (
                    <span className="text-muted-foreground">{t('noAnswer')}</span>
                  )}
                </div>
              </div>

              {guidance?.rubric && guidance.rubric.length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-medium text-muted-foreground">{t('rubric')}</p>
                  <ul className="space-y-1 text-sm">
                    {guidance.rubric.map((r) => (
                      <li key={r.id} className="flex justify-between gap-3 border-b py-1 last:border-0">
                        <span>{r.label}</span>
                        <span className="shrink-0 text-muted-foreground tabular-nums">{r.max}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {guidance?.keywords && guidance.keywords.length > 0 && (
                <div>
                  <p className="mb-1 text-xs font-medium text-muted-foreground">{t('keywords')}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {guidance.keywords.map((k) => (
                      <Badge key={k} variant="outline">
                        {k}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex flex-wrap items-end gap-3">
                <div className="w-28">
                  <label
                    htmlFor={`score-${item.question_id}`}
                    className="mb-1 block text-xs font-medium text-muted-foreground"
                  >
                    {t('score')}
                  </label>
                  <Input
                    id={`score-${item.question_id}`}
                    type="number"
                    inputMode="decimal"
                    min={0}
                    max={item.marks}
                    step="0.5"
                    value={marks[item.question_id] ?? ''}
                    onChange={(e) => {
                      setMarks((prev) => ({ ...prev, [item.question_id]: e.target.value }))
                      setSavedIds((prev) => {
                        const next = new Set(prev)
                        next.delete(item.question_id)
                        return next
                      })
                    }}
                  />
                </div>

                <div className="min-w-48 flex-1">
                  <label
                    htmlFor={`note-${item.question_id}`}
                    className="mb-1 block text-xs font-medium text-muted-foreground"
                  >
                    {t('note')}
                  </label>
                  <Textarea
                    id={`note-${item.question_id}`}
                    rows={2}
                    placeholder={t('notePlaceholder')}
                    value={notes[item.question_id] ?? ''}
                    onChange={(e) =>
                      setNotes((prev) => ({ ...prev, [item.question_id]: e.target.value }))
                    }
                  />
                </div>

                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    onClick={() => save(item.question_id)}
                    disabled={pending || marks[item.question_id] === ''}
                  >
                    {t('save')}
                  </Button>
                  {savedIds.has(item.question_id) && (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <CheckIcon className="size-3.5" />
                      {t('saved')}
                    </span>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        )
      })}

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      <div className="flex justify-end">
        <Button onClick={finish} disabled={pending}>
          {pending ? t('finishing') : t('finish')}
        </Button>
      </div>
    </div>
  )
}

/** The candidate's answer, in whatever shape its format uses. */
function renderAnswer(item: EvaluationItem): string {
  const answer = item.answer as Record<string, unknown> | null
  if (!answer) return ''

  if (typeof answer.text === 'string') return answer.text
  if (Array.isArray(answer.choices)) return answer.choices.join(', ')
  if (typeof answer.choice === 'string') return answer.choice
  if (typeof answer.value === 'boolean') return String(answer.value)
  if (answer.values && typeof answer.values === 'object') {
    return Object.entries(answer.values as Record<string, string>)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n')
  }
  return JSON.stringify(answer)
}
