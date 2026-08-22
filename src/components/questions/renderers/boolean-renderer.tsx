'use client'

import type { AnswerPayload } from '@/lib/questions/schemas'
import type { FormatRendererProps } from '../types'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'

type Answer = Extract<AnswerPayload, { format: 'boolean' }>

export default function BooleanRenderer({
  answer,
  onAnswerChange,
  readOnly,
}: FormatRendererProps) {
  const a = answer as Answer

  return (
    <RadioGroup
      value={a.value === null ? '' : String(a.value)}
      onValueChange={(value) => onAnswerChange?.({ format: 'boolean', value: value === 'true' })}
      disabled={readOnly || !onAnswerChange}
    >
      {[
        { value: 'true', label: 'True' },
        { value: 'false', label: 'False' },
      ].map((option) => (
        <label
          key={option.value}
          className="flex cursor-pointer items-center gap-3 rounded-md border p-3 text-sm has-data-checked:border-primary"
        >
          <RadioGroupItem value={option.value} />
          {option.label}
        </label>
      ))}
    </RadioGroup>
  )
}
