import { getTranslations } from 'next-intl/server'
import { AuthCard } from '@/components/auth/auth-card'
import { ResetPasswordForm } from './reset-password-form'

/**
 * Where the reset email lands.
 *
 * This route did not exist. forgotPasswordAction has always sent people to
 * `/{locale}/reset-password`, so the last step of the password reset flow was
 * a 404 — the request worked, the email arrived, and the link went nowhere.
 *
 * The query parameters are read here rather than in the client component
 * because Supabase reports link failure by redirecting BACK to this URL with
 * `?error=...` instead of with a code. Reading only `code` would show the
 * password form to somebody holding a link that has already been rejected.
 */
export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const t = await getTranslations('auth.resetPassword')
  const params = await searchParams

  const one = (key: string) => {
    const value = params[key]
    return typeof value === 'string' ? value : undefined
  }

  const code = one('code')
  const tokenHash = one('token_hash')
  const linkError = one('error') ?? one('error_code')

  return (
    <AuthCard title={t('title')} description={t('body')}>
      <ResetPasswordForm
        code={linkError ? undefined : code}
        tokenHash={linkError ? undefined : tokenHash}
      />
    </AuthCard>
  )
}
