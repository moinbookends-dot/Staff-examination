'use client'

import type { RubricCriterion } from '@/lib/questions/schemas'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { PlusIcon, XIcon } from 'lucide-react'
import { nextId } from './option-list-editor'

/**
 * Criterion list for essays, practicals and vivas.
 *
 * The rubric is the whole answer key for evaluator_only formats — there is no
 * correct answer to store, only what earns marks. It is also the only thing
 * standing between a dual-chef verification workflow and two people disagreeing
 * with no shared standard to appeal to, which is why `descriptor` ("what full
 * marks looks like") is offered on every row rather than being an advanced
 * option nobody finds.
 *
 * NOTE ON MARKS: criterion maxima are independent of the question's `marks`
 * column. An evaluator scores against the rubric and M5 scales the total. Making
 * them add up here would force a chef to redesign the rubric to change a
 * question's weight in an exam.
 */
export function RubricEditor({
  rubric,
  onChange,
  disabled,
  min = 0,
}: {
  rubric: RubricCriterion[]
  onChange: (rubric: RubricCriterion[]) => void
  disabled?: boolean
  min?: number
}) {
  function update(index: number, patch: Partial<RubricCriterion>) {
    onChange(rubric.map((c, i) => (i === index ? { ...c, ...patch } : c)))
  }

  const total = rubric.reduce((sum, c) => sum + (Number.isFinite(c.max) ? c.max : 0), 0)

  return (
    <div className="space-y-3">
      {rubric.length === 0 && (
        <p className="text-sm text-muted-foreground">
          No criteria yet. Without them an evaluator is scoring on instinct.
        </p>
      )}

      {rubric.map((criterion, index) => (
        <div key={criterion.id} className="space-y-2 rounded-md border p-3">
          <div className="flex items-center gap-2">
            <span className="w-6 shrink-0 text-center font-mono text-xs text-muted-foreground">
              {criterion.id}
            </span>
            <Input
              value={criterion.label}
              onChange={(e) => update(index, { label: e.target.value })}
              placeholder="What is being judged, e.g. Knife control and safety"
              disabled={disabled}
              aria-label={`Criterion ${criterion.id} label`}
            />
            <Input
              type="number"
              min={1}
              step="0.5"
              className="w-24 shrink-0"
              value={criterion.max}
              onChange={(e) => update(index, { max: Number(e.target.value) || 0 })}
              disabled={disabled}
              aria-label={`Criterion ${criterion.id} maximum marks`}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={`Remove criterion ${criterion.id}`}
              disabled={disabled || rubric.length <= min}
              onClick={() => onChange(rubric.filter((_, i) => i !== index))}
            >
              <XIcon />
            </Button>
          </div>

          <Textarea
            value={criterion.descriptor ?? ''}
            onChange={(e) => update(index, { descriptor: e.target.value || undefined })}
            placeholder="What earns full marks — shown to the evaluator"
            rows={2}
            disabled={disabled}
            aria-label={`Criterion ${criterion.id} descriptor`}
          />
        </div>
      ))}

      <div className="flex items-center gap-3">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          onClick={() =>
            onChange([...rubric, { id: nextId(rubric, 'c'), label: '', max: 5 }])
          }
        >
          <PlusIcon />
          Add criterion
        </Button>
        {rubric.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {rubric.length} criteria · {total} marks available to the evaluator
          </span>
        )}
      </div>
    </div>
  )
}
