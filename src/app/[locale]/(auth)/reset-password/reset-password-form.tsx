'use client'

import { useActionState, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { CheckCircle2, Loader2, TriangleAlert } from 'lucide-react'
import { exchangeRecoveryLink, resetPasswordAction, type ActionResult } from '@/server/actions/auth'
import { Link } from '@/lib/i18n/navigation'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { PasswordField } from '@/components/auth/password-field'

type LinkState = 'checking' | 'valid' | 'invalid'

export function ResetPasswordForm({
  code,
  tokenHash,
}: {
  code?: string
  tokenHash?: string
}) {
  const t = useTranslations('auth.resetPassword')
  const tc = useTranslations('common')

  const [link, setLink] = useState<LinkState>(code || tokenHash ? 'checking' : 'invalid')

  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    resetPasswordAction,
    null,
  )

  useEffect(() => {
    if (!code && !tokenHash) return

    // Runs once, and must: both link shapes are single-use, so a second
    // exchange of the same code fails and would flip a working page to
    // "invalid". React 19 double-invokes effects in development, which is
    // exactly the case this guard is here for.
    let cancelled = false
    exchangeRecoveryLink({ code, tokenHash }).then((result) => {
      if (!cancelled) setLink(result.ok ? 'valid' : 'invalid')
    })
    return () => {
      cancelled = true
    }
  }, [code, tokenHash])

  if (state?.ok) {
    return (
      <div className="flex flex-col items-center gap-3 py-2 text-center" role="status">
        <span
          aria-hidden
          className="grid size-11 place-items-center rounded-xl bg-success/12 text-success"
        >
          <CheckCircle2 className="size-5" />
        </span>
        <p className="font-medium">{t('doneTitle')}</p>
        <p className="text-sm text-balance text-muted-foreground">{t('doneBody')}</p>
        <Link href="/login" className="text-sm font-medium underline-offset-4 hover:underline">
          {t('backToSignIn')}
        </Link>
      </div>
    )
  }

  if (link === 'checking') {
    return (
      <p className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
        <Loader2 aria-hidden className="size-4 animate-spin" />
        {tc('loading')}
      </p>
    )
  }

  if (link === 'invalid') {
    return (
      <div className="flex flex-col items-center gap-3 py-2 text-center" role="status">
        <span
          aria-hidden
          className="grid size-11 place-items-center rounded-xl bg-warning/14 text-warning"
        >
          <TriangleAlert className="size-5" />
        </span>
        <p className="font-medium">{t('invalidTitle')}</p>
        {/* Names all three causes rather than saying "invalid or expired".
            "Must be opened in the browser that asked for it" is the one people
            never guess, and it is the one that bites when somebody requests the
            reset on a phone and opens the email on the office desktop. */}
        <p className="text-sm text-balance text-muted-foreground">{t('invalidBody')}</p>
        <Link
          href="/forgot-password"
          className="text-sm font-medium underline-offset-4 hover:underline"
        >
          {t('requestNew')}
        </Link>
      </div>
    )
  }

  return (
    <form action={formAction} className="space-y-4">
      {state?.error && <InlineError>{state.error}</InlineError>}

      <PasswordField
        id="password"
        name="password"
        label={t('password')}
        hint={t('hint')}
        autoComplete="new-password"
        minLength={8}
        required
        autoFocus
        disabled={pending}
      />

      <PasswordField
        id="confirm"
        name="confirm"
        label={t('confirm')}
        autoComplete="new-password"
        minLength={8}
        required
        disabled={pending}
      />

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
