'use client'

import { useEffect, useState, useCallback } from 'react'
import { useTranslations } from 'next-intl'
import { Hourglass, Loader2, RefreshCw } from 'lucide-react'
import { useRouter } from '@/lib/i18n/navigation'
import { createClient } from '@/lib/supabase/client'
import { checkApprovalStatus } from '@/server/actions/auth'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'

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
      <InlineError>
        <span className="font-medium">{t('rejected')}</span>
        {reason && (
          <span className="mt-1 block font-normal">
            {t('reason')}: {reason}
          </span>
        )}
      </InlineError>
    )
  }

  if (status === 'suspended') {
    // Was hardcoded English. A suspended Gujarati-speaking porter was told, in
    // a language they may not read, the one thing they most need to understand.
    return <InlineError>{t('suspended')}</InlineError>
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col items-center gap-3 text-center">
        <span
          aria-hidden
          className="grid size-11 place-items-center rounded-xl bg-warning/14 text-warning"
        >
          <Hourglass className="size-5" />
        </span>
        {/* aria-live: this panel replaces itself when approval lands, and the
            change is what the user is sitting here waiting for. */}
        <p aria-live="polite" className="text-sm text-balance text-muted-foreground">
          {t('body')}
        </p>
      </div>

      <Button variant="outline" className="w-full" onClick={check} disabled={checking}>
        {checking ? <Loader2 className="animate-spin" /> : <RefreshCw />}
        {checking ? t('checking') : t('checkAgain')}
      </Button>
    </div>
  )
}
