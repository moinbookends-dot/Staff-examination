'use client'

import { useActionState } from 'react'
import { useTranslations } from 'next-intl'
import { forgotPasswordAction, type ActionResult } from '@/server/actions/auth'
import { Link } from '@/lib/i18n/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'

export function ForgotPasswordForm({ locale }: { locale: string }) {
  const t = useTranslations('auth.forgotPassword')
  const tc = useTranslations('common')

  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    forgotPasswordAction,
    null,
  )

  // The action returns the same success message whether or not the address is
  // registered, so this branch reveals nothing either way.
  if (state?.ok) {
    return (
      <div className="space-y-4">
        <Alert>
          <AlertDescription>{state.message}</AlertDescription>
        </Alert>
        <Link
          href="/login"
          className="block text-center text-sm text-muted-foreground underline-offset-4 hover:underline"
        >
          {tc('back')}
        </Link>
      </div>
    )
  }

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="locale" value={locale} />

      {state?.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required autoFocus disabled={pending} />
      </div>

      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? tc('loading') : t('submit')}
      </Button>

      <Link
        href="/login"
        className="block text-center text-sm text-muted-foreground underline-offset-4 hover:underline"
      >
        {tc('back')}
      </Link>
    </form>
  )
}
