import { getFormatter, getTranslations } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { PageHeader } from '@/components/ui/page-header'
import { loadMyProfile } from '@/server/actions/profile'
import { ProfileForm } from './profile-form'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * /settings — your own details.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THIS ROUTE CHANGED MEANING ON 11 AUG 2026, AND ITS GUARD CHANGED WITH IT. ║
 * ║                                                                           ║
 * ║ It used to be COMPANY configuration — paper sizes, required languages,    ║
 * ║ difficulty labels, PDF header and footer — behind                         ║
 * ║ requirePermission('settings.manage'), so HR and every employee got a 500. ║
 * ║                                                                           ║
 * ║ Two things were true of that screen: the owner did not want it, and it    ║
 * ║ could not do anything. It rendered a <dl> of values with no form, no      ║
 * ║ inputs and no save — there is no exam_settings mutation anywhere in the   ║
 * ║ application. Nothing was lost by replacing it, and the underlying         ║
 * ║ exam_settings row is untouched and still read by the bank and the PDFs.   ║
 * ║                                                                           ║
 * ║ It is now the one screen every signed-in person needs and did not have:   ║
 * ║ what am I in this system, and how do I correct my own name?               ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * THE GUARD IS requireApproved(), NOT a permission. Editing your own name is
 * not a privilege anybody grants — it is the floor. loadMyProfile() applies it
 * and reads through the caller's own client, so RLS scopes the row to
 * auth.uid() and this page cannot be pointed at somebody else.
 * ═══════════════════════════════════════════════════════════════════════════
 */
/**
 * At module scope, not inside the page.
 *
 * Declaring it in the render body makes a NEW component type on every render,
 * which React cannot reconcile — it unmounts and remounts the subtree rather
 * than updating it. `react-hooks/static-components` catches this, and it is
 * right to: the same mistake on a component that held state would lose what
 * the user had typed.
 */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-label-caps text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-body-sm">{children}</dd>
    </div>
  )
}

export default async function ProfilePage() {
  const t = await getTranslations('profile')
  const format = await getFormatter()

  const profile = await loadMyProfile()

  // requireApproved() has already thrown for anybody unapproved; a null here
  // means the profile row is genuinely absent, which is a 404 rather than an
  // empty screen pretending to be a profile.
  if (!profile) notFound()

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader title={t('title')} description={t('subtitle')} />

      {/* ── What you can change ──────────────────────────────────────────── */}
      <section className="rounded-xl border bg-card p-5">
        <h2 className="text-title-md">{t('yourDetails')}</h2>
        <p className="mt-1 mb-4 text-body-sm text-muted-foreground">{t('yourDetailsHint')}</p>
        <ProfileForm profile={profile} />
      </section>

      {/* ── What a manager set ───────────────────────────────────────────── */}
      <section className="rounded-xl border bg-card p-5">
        <h2 className="text-title-md">{t('yourPlace')}</h2>
        <p className="mt-1 text-body-sm text-muted-foreground">{t('yourPlaceHint')}</p>

        <dl className="mt-4 grid gap-4 sm:grid-cols-2">
          <Fact label={t('email')}>{profile.email}</Fact>
          <Fact label={t('role')}>
            {profile.roles.length > 0 ? profile.roles.join(', ') : t('noRole')}
          </Fact>
          <Fact label={t('company')}>{profile.companyName ?? t('unset')}</Fact>
          <Fact label={t('brand')}>{profile.brandName ?? t('unset')}</Fact>
          <Fact label={t('outlet')}>{profile.outletName ?? t('unset')}</Fact>
          <Fact label={t('department')}>{profile.departmentName ?? t('unset')}</Fact>
          <Fact label={t('employeeCode')}>{profile.employeeCode ?? t('unset')}</Fact>
          <Fact label={t('joined')}>
            {profile.joinedAt
              ? format.dateTime(new Date(profile.joinedAt), { dateStyle: 'medium' })
              : format.dateTime(new Date(profile.createdAt), { dateStyle: 'medium' })}
          </Fact>
        </dl>
      </section>
    </div>
  )
}
