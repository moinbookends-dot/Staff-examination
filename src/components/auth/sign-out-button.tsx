'use client'

import { useFormStatus } from 'react-dom'
import { Loader2 } from 'lucide-react'
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
}) {
  const { pending } = useFormStatus()

  return (
    <Button type="submit" variant={variant} size={size} className={className} disabled={pending}>
      {pending && <Loader2 className="animate-spin" />}
      {pending ? pendingLabel : label}
    </Button>
  )
}
