'use client'

import { useId, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Eye, EyeOff } from 'lucide-react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

/**
 * A password input with a reveal toggle.
 *
 * Not a nicety for this audience. The people typing into this are line cooks
 * and porters on phones, mid-shift, often with wet or gloved hands, entering a
 * password chosen for them by a manager. A masked field they cannot check is
 * the single most common reason a correct password gets typed wrong three
 * times and the account locks.
 *
 * The toggle is `type="button"` — inside a <form>, a <button> with no type
 * submits it, which would post the form on the first tap. It is also excluded
 * from the tab order (`tabIndex={-1}`): a keyboard user tabbing from the
 * password field expects to land on the submit button, not on a control that
 * changes how the field is displayed.
 *
 * `hint` is wired through aria-describedby rather than left as a loose
 * paragraph, so "At least 8 characters" is actually read out with the field
 * instead of being announced as unrelated text somewhere after it.
 */
export function PasswordField({
  id,
  name,
  label,
  hint,
  autoComplete,
  minLength,
  required,
  disabled,
  autoFocus,
  className,
}: {
  id: string
  name: string
  label: string
  hint?: string
  autoComplete?: string
  minLength?: number
  required?: boolean
  disabled?: boolean
  autoFocus?: boolean
  className?: string
}) {
  const t = useTranslations('auth.login')
  const [visible, setVisible] = useState(false)
  const hintId = useId()

  return (
    <div className={cn('space-y-2', className)}>
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        <Input
          id={id}
          name={name}
          type={visible ? 'text' : 'password'}
          autoComplete={autoComplete}
          minLength={minLength}
          required={required}
          disabled={disabled}
          autoFocus={autoFocus}
          aria-describedby={hint ? hintId : undefined}
          className="pr-10"
        />
        <button
          type="button"
          tabIndex={-1}
          onClick={() => setVisible((v) => !v)}
          disabled={disabled}
          aria-label={visible ? t('hidePassword') : t('showPassword')}
          aria-pressed={visible}
          className="absolute inset-y-0 right-0 grid w-10 place-items-center rounded-r-lg text-muted-foreground transition-colors hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none disabled:opacity-50"
        >
          {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </button>
      </div>
      {hint && (
        <p id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </p>
      )}
    </div>
  )
}
