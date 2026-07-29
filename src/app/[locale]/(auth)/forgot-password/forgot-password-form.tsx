'use client'

import { useActionState } from 'react'
import { useTranslations } from 'next-intl'
import { Loader2, Mail, MailCheck } from 'lucide-react'
import { forgotPasswordAction, type ActionResult } from '@/server/actions/auth'
import { Link } from '@/lib/i18n/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { InlineError } from '@/components/ui/inline-error'

export function ForgotPasswordForm({ locale }: { locale: string }) {
  const t = useTranslations('auth.forgotPassword')
  const tc = useTranslations('common')

  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    forgotPasswordAction,
    null,
  )

  // The action returns the same success message whether or not the address is
  // registered, so this branch reveals nothing either way. The confirmation is
  // deliberately shaped like an outcome rather than a neutral notice — someone
  // who mistypes their address and sees a bland "we'll email you" will sit and
  // wait for a message that is never coming.
  if (state?.ok) {
    return (
      <div className="flex flex-col items-center gap-3 py-2 text-center" role="status">
        <span
          aria-hidden
          className="grid size-11 place-items-center rounded-xl bg-info/12 text-info"
        >
          <MailCheck className="size-5" />
        </span>
        <p className="font-medium">{t('sentTitle')}</p>
        <p className="text-sm text-balance text-muted-foreground">{state.message}</p>
        <Link
          href="/login"
          className="text-sm font-medium underline-offset-4 hover:underline"
        >
          {t('backToSignIn')}
        </Link>
      </div>
    )
  }

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="locale" value={locale} />

      {state?.error && <InlineError>{state.error}</InlineError>}

      <div className="space-y-2">
        <Label htmlFor="email">{t('email')}</Label>
        <div className="relative">
          <Mail
            aria-hidden
            className="pointer-events-none absolute inset-y-0 left-3 my-auto size-4 text-muted-foreground"
          />
          <Input
            id="email"
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            autoFocus
            disabled={pending}
            className="pl-9"
          />
        </div>
      </div>

      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        {pending && <Loader2 className="animate-spin" />}
        {pending ? tc('loading') : t('submit')}
      </Button>

      <Link
        href="/login"
        className="block text-center text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
      >
        {t('backToSignIn')}
      </Link>
    </form>
  )
}
