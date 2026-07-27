'use client'

import { useActionState } from 'react'
import { useTranslations } from 'next-intl'
import { useSearchParams } from 'next/navigation'
import { loginAction, type ActionResult } from '@/server/actions/auth'
import { Link } from '@/lib/i18n/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'

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

      {state?.error && (
        <Alert variant="destructive">
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}

      <div className="space-y-2">
        <Label htmlFor="email">{t('email')}</Label>
        <Input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          autoFocus
          disabled={pending}
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label htmlFor="password">{t('password')}</Label>
          <Link
            href="/forgot-password"
            className="text-xs text-muted-foreground underline-offset-4 hover:underline"
          >
            {t('forgot')}
          </Link>
        </div>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          disabled={pending}
        />
      </div>

      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? tc('loading') : t('submit')}
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        {t('noAccount')}{' '}
        <Link href="/register" className="font-medium text-foreground underline-offset-4 hover:underline">
          {t('register')}
        </Link>
      </p>
    </form>
  )
}
