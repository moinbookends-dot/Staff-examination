'use client'

import { useEffect, useState, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter } from '@/lib/i18n/navigation'
import { createClient } from '@/lib/supabase/client'
import { checkApprovalStatus } from '@/server/actions/auth'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'

type Status = 'pending' | 'approved' | 'rejected' | 'suspended' | 'unknown'

/**
 * The JWT staleness handshake (plan §5.5, migration 0004).
 *
 * THE PROBLEM: app claims are baked into the access token when it is minted.
 * A user approved thirty seconds ago still carries `approved: false` until
 * their token refreshes — potentially the full token lifetime. Middleware reads
 * that claim, so it would keep bouncing an already-approved user back here.
 * From their side the system looks broken: the chef says "you're approved",
 * the screen says "awaiting approval".
 *
 * THE FIX, in three steps:
 *   1. Poll me_status(), which reads `profiles` directly and ignores the claim.
 *   2. On approval, call refreshSession() to mint a token carrying it.
 *   3. Only then navigate — so middleware sees approved: true and lets them by.
 *
 * Skipping step 2 produces a redirect loop that is genuinely hard to diagnose,
 * because every individual piece is behaving correctly.
 */
export function PendingClient({ initialStatus, initialReason }: {
  initialStatus: Status
  initialReason?: string | null
}) {
  const t = useTranslations('auth.pending')
  const router = useRouter()

  const [status, setStatus] = useState<Status>(initialStatus)
  const [reason, setReason] = useState<string | null | undefined>(initialReason)
  const [checking, setChecking] = useState(false)

  const check = useCallback(async () => {
    setChecking(true)
    try {
      const result = await checkApprovalStatus()
      setStatus(result.status)
      setReason(result.reason)

      if (result.status === 'approved') {
        // Step 2. Without this the token still says approved: false and
        // middleware sends them straight back here.
        await createClient().auth.refreshSession()
        router.replace('/dashboard')
      }
    } finally {
      setChecking(false)
    }
  }, [router])

  useEffect(() => {
    if (status !== 'pending') return

    // 15s: approval is a human action taken minutes to hours after
    // registration, so tighter polling only burns free-tier requests. The
    // manual button covers the impatient case.
    const id = setInterval(check, 15_000)
    return () => clearInterval(id)
  }, [status, check])

  if (status === 'rejected') {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          <p className="font-medium">{t('rejected')}</p>
          {reason && (
            <p className="mt-2 text-sm">
              {t('reason')}: {reason}
            </p>
          )}
        </AlertDescription>
      </Alert>
    )
  }

  if (status === 'suspended') {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          Your account has been suspended. Contact your manager.
        </AlertDescription>
      </Alert>
    )
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">{t('body')}</p>
      <Button variant="outline" className="w-full" onClick={check} disabled={checking}>
        {checking ? t('checking') : 'Check again'}
      </Button>
    </div>
  )
}
