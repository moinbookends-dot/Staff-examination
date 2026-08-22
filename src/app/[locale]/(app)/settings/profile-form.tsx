'use client'

import { useActionState, useState } from 'react'
import { useTranslations } from 'next-intl'
import { CheckCircle2Icon, Loader2Icon } from 'lucide-react'
import { updateMyProfile, type MyProfile, type ProfileResult } from '@/server/actions/profile'
import { LOCALE_LABELS, routing } from '@/lib/i18n/routing'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { InlineError } from '@/components/ui/inline-error'

const SELECT_CLASS =
  'flex h-9 w-full rounded-lg border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50'

/**
 * The three fields a person may change about themselves.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE READ-ONLY HALF IS NOT DISABLED INPUTS.                               │
 * │                                                                           │
 * │ Email, role, outlet and department are rendered as a description list,    │
 * │ not as greyed-out fields. A disabled input still looks like a control     │
 * │ that is temporarily unavailable — people click it, then hunt for the      │
 * │ thing that unlocks it. A <dl> says plainly "this is a fact about you",    │
 * │ which is what those are: set by a manager during approval.                │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export function ProfileForm({ profile }: { profile: MyProfile }) {
  const t = useTranslations('profile')
  const tc = useTranslations('common')

  const [state, formAction, pending] = useActionState<ProfileResult | null, FormData>(
    async (_prev, formData) =>
      updateMyProfile({
        fullName: formData.get('fullName'),
        phone: formData.get('phone') ?? '',
        preferredLocale: formData.get('preferredLocale'),
      }),
    null,
  )

  // Local, so the Save button can tell "nothing changed" from "not saved yet".
  const [dirty, setDirty] = useState(false)

  return (
    <form action={formAction} className="space-y-4" onChange={() => setDirty(true)}>
      {state && !state.ok && <InlineError>{state.message}</InlineError>}
      {state?.ok && !dirty && (
        <p role="status" className="flex items-center gap-2 text-sm text-success">
          <CheckCircle2Icon aria-hidden className="size-4" />
          {t('saved')}
        </p>
      )}

      <div className="space-y-2">
        <Label htmlFor="fullName">{t('fullName')}</Label>
        <Input
          id="fullName"
          name="fullName"
          defaultValue={profile.fullName}
          autoComplete="name"
          required
          minLength={2}
          disabled={pending}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="phone">{t('phone')}</Label>
        <Input
          id="phone"
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          defaultValue={profile.phone ?? ''}
          disabled={pending}
        />
        <p className="text-xs text-muted-foreground">{t('phoneHint')}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="preferredLocale">{t('language')}</Label>
        <select
          id="preferredLocale"
          name="preferredLocale"
          defaultValue={profile.preferredLocale}
          disabled={pending}
          className={SELECT_CLASS}
        >
          {routing.locales.map((l) => (
            <option key={l} value={l}>
              {LOCALE_LABELS[l]}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">{t('languageHint')}</p>
      </div>

      <Button type="submit" disabled={pending || !dirty}>
        {pending && <Loader2Icon className="animate-spin" />}
        {pending ? tc('loading') : t('save')}
      </Button>
    </form>
  )
}
