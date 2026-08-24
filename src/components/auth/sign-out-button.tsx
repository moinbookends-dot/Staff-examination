'use client'

import { useFormStatus } from 'react-dom'
import { Loader2, LogOut as LogOutIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * The submit button for a sign-out form, with a real pending state.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHY THIS IS NOT JUST TIDINESS ON /pending.                                │
 * │                                                                           │
 * │ Every other button in the auth flow shows a spinner while its action runs │
 * │ because they use useActionState, which hands back `pending`. Sign-out is  │
 * │ a bare `<form action={serverAction}>` with no state, so it had none — and │
 * │ signing out is a NETWORK ROUND TRIP that ends in a redirect. On a phone   │
 * │ in a kitchen that is a visible pause with no acknowledgement, and the     │
 * │ reasonable response is to tap again.                                      │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * useFormStatus() rather than a local useState: it reads the status of the
 * enclosing form, so it stays right no matter what the action does, and the
 * component must be a CHILD of the <form> for that to work.
 */
export function SignOutButton({
  label,
  iconOnBelowMd = false,
  pendingLabel,
  variant = 'ghost',
  size = 'sm',
  className,
}: {
  label: string
  pendingLabel: string
  variant?: 'ghost' | 'outline'
  size?: 'sm' | 'default'
  className?: string
  /**
   * Collapse to an icon below `md`.
   *
   * The word "Sign out" is 68px wide, and on a 320px header that is the
   * difference between the row fitting and the whole page sliding
   * sideways. The label stays as the accessible name, so nothing is lost
   * to a screen reader — only to sighted users who have the icon instead.
   */
  iconOnBelowMd?: boolean
}) {
  const { pending } = useFormStatus()

  return (
    <Button
      type="submit"
      variant={variant}
      size={size}
      className={className}
      disabled={pending}
      // Only when the text is hidden — a button that already reads its own
      // label does not need a second, competing name.
      aria-label={iconOnBelowMd ? label : undefined}
    >
      {pending && <Loader2 className="animate-spin" />}
      {iconOnBelowMd && !pending && <LogOutIcon aria-hidden className="size-4 md:hidden" />}
      <span className={iconOnBelowMd ? "hidden md:inline" : undefined}>
        {pending ? pendingLabel : label}
      </span>
    </Button>
  )
}
