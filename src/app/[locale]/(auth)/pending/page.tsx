import { getTranslations } from 'next-intl/server'
import { AuthCard } from '@/components/auth/auth-card'
import { checkApprovalStatus, logoutAction } from '@/server/actions/auth'
import { Button } from '@/components/ui/button'
import { PendingClient } from './pending-client'

export default async function PendingPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  const t = await getTranslations('auth.pending')
  const tc = await getTranslations('common')

  // Read server-side first so the page renders the true state immediately
  // rather than flashing "pending" for one poll interval to someone who has
  // already been approved.
  const { status, reason } = await checkApprovalStatus()

  const signOut = async () => {
    'use server'
    await logoutAction(locale)
  }

  return (
    <AuthCard title={t('title')}>
      <div className="space-y-6">
        <PendingClient initialStatus={status} initialReason={reason} />

        <form action={signOut}>
          <Button type="submit" variant="ghost" size="sm" className="w-full">
            {tc('signOut')}
          </Button>
        </form>
      </div>
    </AuthCard>
  )
}
