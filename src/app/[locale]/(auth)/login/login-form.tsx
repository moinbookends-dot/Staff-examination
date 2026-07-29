'use client'

import { useActionState } from 'react'
import { useTranslations } from 'next-intl'
import { useSearchParams } from 'next/navigation'
import { Loader2, Mail } from 'lucide-react'
import { loginAction, type ActionResult } from '@/server/actions/auth'
import { Link } from '@/lib/i18n/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { InlineError } from '@/components/ui/inline-error'
import { PasswordField } from '@/components/auth/password-field'

export function LoginForm({ locale }: { locale: string }) {
  const t = useTranslations('auth.login')
  const tc = useTranslations('common')
  const searchParams = useSearchParams()
  const next = searchParams.get('next') ?? ''

  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    loginAction,
    null,
  )

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="locale" value={locale} />
      {/* Where middleware wanted to send them before the redirect to login.
          loginAction validates this is a same-origin relative path. */}
      <input type="hidden" name="next" value={next} />

      {/* InlineError rather than Alert: both carry role="alert", but this one
          leads with an icon, so the failure is legible without reading it. */}
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

      <div className="space-y-2">
        <PasswordField
          id="password"
          name="password"
          label={t('password')}
          autoComplete="current-password"
          required
          disabled={pending}
        />
        <div className="flex justify-end">
          <Link
            href="/forgot-password"
            className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            {t('forgot')}
          </Link>
        </div>
      </div>

      {/* The spinner is a PRECEDING sibling of the label, never a wrapper —
          the render check matches `>Label<` text nodes, and anything between
          the `>` and the first character breaks it. */}
      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        {pending && <Loader2 className="animate-spin" />}
        {pending ? tc('loading') : t('submit')}
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        {t('noAccount')}{' '}
        <Link
          href="/register"
          className="font-medium text-foreground underline-offset-4 hover:underline"
        >
          {t('register')}
        </Link>
      </p>
    </form>
  )
}
