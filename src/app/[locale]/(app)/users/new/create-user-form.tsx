'use client'

import { useActionState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/lib/i18n/navigation'
import { createUser, type CreateUserResult } from '@/server/actions/users'
import type { OrgOption } from '@/server/actions/org'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { InlineError } from '@/components/ui/inline-error'

/**
 * The create-user form.
 *
 * Outlet and department are chosen HERE, by the admin, exactly as they are on
 * an approval — these two fields decide the person's entire data scope under
 * RLS, so they are an authority decision even when the authority is also the
 * one typing the name. The password is set by the admin and handed over in
 * person; the account arrives verified and approved, ready to sign in.
 *
 * On success the router goes to the new person's page — the proof the account
 * exists is the account, not a toast.
 */
export function CreateUserForm({
  outlets,
  departments,
}: {
  outlets: OrgOption[]
  departments: OrgOption[]
}) {
  const t = useTranslations('users')
  const router = useRouter()

  const [state, formAction, pending] = useActionState<CreateUserResult | null, FormData>(
    async (_prev, formData) => {
      const result = await createUser({
        fullName: formData.get('fullName'),
        email: formData.get('email'),
        password: formData.get('password'),
        phone: formData.get('phone'),
        locale: formData.get('locale'),
        outletId: formData.get('outletId'),
        departmentId: formData.get('departmentId'),
      })
      if (result.ok && result.userId) {
        router.push(`/users/${result.userId}`)
      }
      return result
    },
    null,
  )

  const selectClass =
    'w-full min-h-11 rounded-md border border-input bg-transparent px-2 text-sm md:min-h-9'

  return (
    <form action={formAction} className="space-y-4">
      {state && !state.ok && <InlineError>{state.error}</InlineError>}

      <div className="space-y-2">
        <Label htmlFor="cu-name">{t('createFullName')}</Label>
        <Input id="cu-name" name="fullName" disabled={pending} required maxLength={120} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="cu-email">{t('createEmail')}</Label>
        <Input id="cu-email" name="email" type="email" disabled={pending} required />
      </div>

      <div className="space-y-2">
        <Label htmlFor="cu-password">{t('createPassword')}</Label>
        <Input
          id="cu-password"
          name="password"
          type="password"
          disabled={pending}
          required
          minLength={8}
          maxLength={72}
          autoComplete="new-password"
        />
        <p className="text-xs text-muted-foreground">{t('createPasswordHint')}</p>
      </div>

      <div className="space-y-2">
        <Label htmlFor="cu-phone">{t('createPhone')}</Label>
        <Input id="cu-phone" name="phone" type="tel" disabled={pending} maxLength={30} />
      </div>

      <div className="space-y-2">
        <Label htmlFor="cu-locale">{t('createLocale')}</Label>
        <select id="cu-locale" name="locale" disabled={pending} className={selectClass} defaultValue="en">
          <option value="en">English</option>
          <option value="hi">हिन्दी</option>
          <option value="gu">ગુજરાતી</option>
        </select>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="cu-outlet">{t('createOutlet')}</Label>
          <select id="cu-outlet" name="outletId" disabled={pending} required className={selectClass} defaultValue="">
            <option value="" disabled>
              {t('createChoose')}
            </option>
            {outlets.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
              </option>
            ))}
          </select>
        </div>
        <div className="space-y-2">
          <Label htmlFor="cu-department">{t('createDepartment')}</Label>
          <select
            id="cu-department"
            name="departmentId"
            disabled={pending}
            required
            className={selectClass}
            defaultValue=""
          >
            <option value="" disabled>
              {t('createChoose')}
            </option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      <Button type="submit" size="lg" disabled={pending} className="w-full">
        {pending ? t('createSubmitting') : t('createSubmit')}
      </Button>
    </form>
  )
}
