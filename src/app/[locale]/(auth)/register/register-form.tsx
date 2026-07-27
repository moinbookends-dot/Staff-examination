'use client'

import { useActionState } from 'react'
import { useTranslations } from 'next-intl'
import { registerAction, type ActionResult } from '@/server/actions/auth'
import type { OrgOption } from '@/server/actions/org'
import { Link } from '@/lib/i18n/navigation'
import { LOCALE_LABELS, routing } from '@/lib/i18n/routing'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Alert, AlertDescription } from '@/components/ui/alert'

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
      <Alert>
        <AlertDescription>{state.message}</AlertDescription>
      </Alert>
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
        <Label htmlFor="fullName">{t('fullName')}</Label>
        <Input id="fullName" name="fullName" required autoFocus disabled={pending} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="email">Email</Label>
        <Input id="email" name="email" type="email" autoComplete="email" required disabled={pending} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
          disabled={pending}
        />
        <p className="text-xs text-muted-foreground">At least 8 characters.</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="phone">{t('phone')}</Label>
        <Input id="phone" name="phone" type="tel" autoComplete="tel" disabled={pending} />
      </div>

      {/*
        Outlet and department are collected here for the approving chef's
        benefit — they are NOT submitted as account attributes. The register
        action's schema ignores them entirely and the database trigger reads
        only display fields from the signup payload. A user asserting their own
        outlet would be asserting their own data scope, which RLS then trusts.
        The chef sets both during approval.
      */}
      <div className="space-y-2">
        <Label htmlFor="outletHint">{t('outlet')}</Label>
        <select
          id="outletHint"
          name="outletHint"
          disabled={pending}
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
        >
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
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
        >
          <option value="">—</option>
          {departments.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="preferredLocale">{t('preferredLanguage')}</Label>
        <select
          id="preferredLocale"
          name="preferredLocale"
          defaultValue={locale}
          disabled={pending}
          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-50"
        >
          {routing.locales.map((l) => (
            <option key={l} value={l}>{LOCALE_LABELS[l]}</option>
          ))}
        </select>
      </div>

      <Button type="submit" className="w-full" disabled={pending}>
        {pending ? tc('loading') : t('submit')}
      </Button>

      <p className="text-center text-sm text-muted-foreground">
        {t('hasAccount')}{' '}
        <Link href="/login" className="font-medium text-foreground underline-offset-4 hover:underline">
          Sign in
        </Link>
      </p>
    </form>
  )
}
