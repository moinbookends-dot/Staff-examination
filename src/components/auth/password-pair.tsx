'use client'

import { useId, useState } from 'react'
import { PasswordField } from './password-field'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A password and its confirmation, checked in the browser.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHY THE CHECK BELONGS HERE AND NOT ONLY IN THE ACTION.                    │
 * │                                                                           │
 * │ resetPasswordAction already refuses a mismatch, and that refusal is the   │
 * │ authority — nothing here replaces it. But a Server Action round trip      │
 * │ re-renders the form, and a re-rendered <input type="password"> comes back │
 * │ EMPTY. So the sole feedback for a typo was both fields cleared and one    │
 * │ line of red text, on a phone, mid-shift. The person retypes a long        │
 * │ password twice more to find out whether they got it right this time.      │
 * │                                                                           │
 * │ Telling them before they submit costs one comparison.                     │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * `mismatch` is passed in rather than read from a namespace here: the two
 * screens that use this live under auth.register and auth.resetPassword, and a
 * component that reached into one of them would render the wrong screen's
 * wording on the other.
 *
 * The message is NOT rendered as an InlineError. That component is
 * `role="alert"`, which announces on every keystroke while somebody is still
 * typing the second field — the assistive-technology equivalent of shouting.
 * It is tied to the field with aria-describedby and aria-invalid instead, so it
 * is read when the field is reached and not before.
 */
export function PasswordPair({
  passwordLabel,
  confirmLabel,
  mismatchLabel,
  hint,
  disabled,
  autoFocus,
}: {
  passwordLabel: string
  confirmLabel: string
  mismatchLabel: string
  hint?: string
  disabled?: boolean
  autoFocus?: boolean
}) {
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const errorId = useId()

  // Only once the second field has something in it. Flagging a mismatch on the
  // first character typed into an empty confirmation is noise, not help.
  const mismatch = confirm.length > 0 && password !== confirm

  return (
    <>
      <PasswordField
        id="password"
        name="password"
        label={passwordLabel}
        hint={hint}
        autoComplete="new-password"
        minLength={8}
        required
        autoFocus={autoFocus}
        disabled={disabled}
        value={password}
        onValueChange={setPassword}
      />

      <div className="space-y-2">
        <PasswordField
          id="confirm"
          name="confirm"
          label={confirmLabel}
          autoComplete="new-password"
          minLength={8}
          required
          disabled={disabled}
          value={confirm}
          onValueChange={setConfirm}
          invalid={mismatch}
          describedBy={mismatch ? errorId : undefined}
        />
        {mismatch && (
          <p id={errorId} className="text-xs text-destructive">
            {mismatchLabel}
          </p>
        )}
      </div>
    </>
  )
}
