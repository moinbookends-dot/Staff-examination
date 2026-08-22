'use client'

import { useActionState } from 'react'
import { useTranslations } from 'next-intl'
import { Loader2, Mail } from 'lucide-react'
import { registerAction, type ActionResult } from '@/server/actions/auth'
import type { OrgOption } from '@/server/actions/org'
import { Link } from '@/lib/i18n/navigation'
import { LOCALE_LABELS, routing } from '@/lib/i18n/routing'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { InlineError } from '@/components/ui/inline-error'
import { PasswordPair } from '@/components/auth/password-pair'

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

  /*
   * There is no success branch here any more, and its absence is the point.
   *
   * This used to render "check your email for a verification link" with a link
   * back to sign-in — a dead end in two ways. The link 404'd (there was no
   * /auth/confirm route), and even once it did not, there was nowhere on this
   * screen to type a code. registerAction now redirects to /verify-email
   * carrying the address, so a successful signup never returns a result at all:
   * redirect() throws, and `state` stays null.
   */
  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="locale" value={locale} />

      {state?.error && <InlineError>{state.error}</InlineError>}

      <div className="space-y-2">
        <Label htmlFor="fullName">{t('fullName')}</Label>
        {/* autoComplete="name" was missing, so the one field every phone can
            fill from its own contact card was the one field typed by hand. */}
        <Input
          id="fullName"
          name="fullName"
          autoComplete="name"
          required
          autoFocus
          disabled={pending}
        />
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

      {/*
        A confirmation field, which registration did not have.
        Reset-password has always had one; signup did not, so the single place
        where a typo is unrecoverable — you cannot sign in to fix it, and the
        reset email goes to the address you may also have mistyped — was the
        one place the password was typed once and never checked.
      */}
      <PasswordPair
        passwordLabel={t('password')}
        confirmLabel={t('confirmPassword')}
        mismatchLabel={t('mismatch')}
        hint={t('passwordHint')}
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

      {/*
        ┌───────────────────────────────────────────────────────────────────┐
        │ THIS CONTROL WAS DECORATIVE, AND ON THIS PRODUCT THAT MATTERS.    │
        │                                                                   │
        │ It posted as `preferredLocale`; registerAction read a HIDDEN      │
        │ `locale` field carrying the URL's locale and ignored this         │
        │ entirely. So a Gujarati speaker handed an /en/register link chose │
        │ ગુજરાતી, was told nothing, and got an English account — on an     │
        │ application whose stated purpose is that a porter can use it in   │
        │ their own language.                                               │
        │                                                                   │
        │ It is now the field the action reads. The hidden `locale` stays,  │
        │ but only to decide where to redirect afterwards.                  │
        └───────────────────────────────────────────────────────────────────┘
      */}
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
