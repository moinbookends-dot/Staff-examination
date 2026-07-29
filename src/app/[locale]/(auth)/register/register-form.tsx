'use client'

import { useActionState } from 'react'
import { useTranslations } from 'next-intl'
import { CheckCircle2, Loader2, Mail } from 'lucide-react'
import { registerAction, type ActionResult } from '@/server/actions/auth'
import type { OrgOption } from '@/server/actions/org'
import { Link } from '@/lib/i18n/navigation'
import { LOCALE_LABELS, routing } from '@/lib/i18n/routing'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { InlineError } from '@/components/ui/inline-error'
import { PasswordField } from '@/components/auth/password-field'

/**
 * Native <select>, styled to match Input.
 *
 * Deliberately NOT the shadcn Select primitive. These post inside a plain
 * <form action={formAction}>, so the value has to reach the FormData without
 * JavaScript deciding to participate — and on the phones this is filled in on,
 * the OS picker is a better control than anything rendered in the page.
 */
const SELECT_CLASS =
  'flex h-9 w-full rounded-lg border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50'

export function RegisterForm({
  locale,
  outlets,
  departments,
}: {
  locale: string
  outlets: OrgOption[]
  departments: OrgOption[]
}) {
  const t = useTranslations('auth.register')
  const tc = useTranslations('common')

  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    registerAction,
    null,
  )

  if (state?.ok) {
    return (
      <div className="flex flex-col items-center gap-3 py-4 text-center" role="status">
        <span
          aria-hidden
          className="grid size-11 place-items-center rounded-xl bg-success/12 text-success"
        >
          <CheckCircle2 className="size-5" />
        </span>
        <p className="text-sm text-balance">{state.message}</p>
        <Link
          href="/login"
          className="text-sm font-medium underline-offset-4 hover:underline"
        >
          {t('signIn')}
        </Link>
      </div>
    )
  }

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="locale" value={locale} />

      {state?.error && <InlineError>{state.error}</InlineError>}

      <div className="space-y-2">
        <Label htmlFor="fullName">{t('fullName')}</Label>
        <Input id="fullName" name="fullName" required autoFocus disabled={pending} />
      </div>

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
            disabled={pending}
            className="pl-9"
          />
        </div>
      </div>

      <PasswordField
        id="password"
        name="password"
        label={t('password')}
        hint={t('passwordHint')}
        autoComplete="new-password"
        minLength={8}
        required
        disabled={pending}
      />

      <div className="space-y-2">
        <Label htmlFor="phone">{t('phone')}</Label>
        <Input id="phone" name="phone" type="tel" inputMode="tel" autoComplete="tel" disabled={pending} />
      </div>

      {/*
        Outlet and department are collected here for the approving chef's
        benefit — they are NOT submitted as account attributes. The register
        action's schema ignores them entirely and the database trigger reads
        only display fields from the signup payload. A user asserting their own
        outlet would be asserting their own data scope, which RLS then trusts.
        The chef sets both during approval.
      */}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="outletHint">{t('outlet')}</Label>
          <select id="outletHint" name="outletHint" disabled={pending} className={SELECT_CLASS}>
            <option value="">—</option>
            {outlets.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="departmentHint">{t('department')}</Label>
          <select
            id="departmentHint"
            name="departmentHint"
            disabled={pending}
            className={SELECT_CLASS}
          >
            <option value="">—</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="preferredLocale">{t('preferredLanguage')}</Label>
        <select
          id="preferredLocale"
          name="preferredLocale"
          defaultValue={locale}
          disabled={pending}
          className={SELECT_CLASS}
        >
          {routing.locales.map((l) => (
            <option key={l} value={l}>{LOCALE_LABELS[l]}</option>
          ))}
        </select>
      </div>

      <Button type="submit" size="lg" className="w-full" disabled={pending}>
        {pending && <Loader2 className="animate-spin" />}
        {pending ? tc('loading') : t('submit')}
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        {t('hasAccount')}{' '}
        <Link
          href="/login"
          className="font-medium text-foreground underline-offset-4 hover:underline"
        >
          {t('signIn')}
        </Link>
      </p>
    </form>
  )
}
