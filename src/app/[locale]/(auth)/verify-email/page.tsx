import { getTranslations } from 'next-intl/server'
import { AuthCard } from '@/components/auth/auth-card'
import { VerifyEmailForm } from './verify-email-form'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Confirming an email address with the emailed code.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ REACHABLE WITHOUT A SESSION, AND IT HAS TO BE.                            │
 * │                                                                           │
 * │ mailer_autoconfirm is false on this project, so signUp() sends a mail and │
 * │ establishes NO session. A person arriving here has an account and no      │
 * │ token, which is why the address travels in the query string — there is no │
 * │ cookie to carry it and no session to look it up from.                     │
 * │                                                                           │
 * │ It is also reachable WITH a session, by the proxy, for anyone whose token │
 * │ says email_verified: false. Both entry points land on the same screen.    │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * WHY THE ADDRESS IS NOT TRUSTED FOR ANYTHING. It selects which account the
 * code is checked against, and nothing more: verifyOtp() refuses unless the
 * code matches the one GoTrue emailed to that address. Editing the query
 * parameter to somebody else's address gets you a form you cannot complete.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export default async function VerifyEmailPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { locale } = await params
  const t = await getTranslations('auth.verifyEmail')
  const query = await searchParams

  const raw = query.email
  const email = typeof raw === 'string' ? raw.trim().toLowerCase() : ''

  // Set by /auth/confirm when a LINK is rejected. That redirect cannot carry
  // the address — Supabase's error response does not include it — so this
  // arrives without one and the form asks for it.
  const linkExpired = query.expired === '1'

  return (
    <AuthCard title={t('title')} description={t('body')}>
      <VerifyEmailForm locale={locale} email={email} linkExpired={linkExpired} />
    </AuthCard>
  )
}
