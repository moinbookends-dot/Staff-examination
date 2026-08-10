'use client'

import { useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { RefreshCw, TriangleAlert, ShieldOff } from 'lucide-react'
import { Link } from '@/lib/i18n/navigation'
import { Button, buttonVariants } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The first error boundary in the application.
 *
 * There was none — not here, not at the root. Every server action guard throws
 * a typed error (AuthorizationError 403, AuthenticationError 401,
 * ApprovalPendingError 403), and with no boundary each one became a raw 500
 * with Next's default page.
 *
 * That is not hypothetical. /reports gates its team sections on
 * `reports.read_team || reports.read_all` and then calls three actions guarded
 * on `reports.read_team` alone, so an HR user — who holds read_all and not
 * read_team — gets an uncaught throw. Verified against this database:
 * /en/reports and /api/reports/export both return 500 for HR today.
 *
 * It matters most on /dashboard, which is the one route nobody can route
 * around: the proxy sends any signed-in user here from an auth page,
 * loginAction defaults here, / redirects here, /pending forwards here on
 * approval, and the "your account was approved" notification links here. A
 * throw there is not a broken tile — it is that role locked out of the product
 * on the first screen they ever see.
 *
 * WHY IT DOES NOT SHOW error.message. The thrown text is
 * "Missing required permission: reports.read_team", which tells a kitchen
 * porter nothing and tells anyone else exactly which permission keys exist.
 * The digest goes to the server log where it belongs.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ IT USED TO SAY BOTH THINGS AT ONCE, AND SO WAS WRONG EITHER WAY.          │
 * │                                                                           │
 * │ Every error rendered the headline "Something went wrong" AND the body     │
 * │ "You don't have permission to view this". A refused page therefore read   │
 * │ as a crash, and a genuine crash — a dropped connection, a failed query —  │
 * │ told the user they lacked a permission they actually held, sending them   │
 * │ to an administrator for a problem an administrator cannot fix.            │
 * │                                                                           │
 * │ THE DISCRIMINATOR IS `digest`, NOT `name`. A production build replaces    │
 * │ both `message` and `name` on a server error before it reaches the client, │
 * │ so matching on `name` worked in dev and failed silently once built — a    │
 * │ refused page went back to reading "Something went wrong at our end". The  │
 * │ guards in src/lib/auth/guards.ts set a stable digest instead, which Next  │
 * │ passes through untouched.                                                 │
 * │                                                                           │
 * │ RETRY IS HIDDEN FOR A REFUSAL. Permissions do not change between two      │
 * │ clicks; the button could only ever fail again, and offering it implies    │
 * │ the denial was a glitch worth arguing with.                               │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * The marker all three guards in src/lib/auth/guards.ts carry.
 *
 * Duplicated as a literal rather than imported: guards.ts begins with
 * `import 'server-only'`, and this is a Client Component.
 */
const REFUSAL_DIGEST = 'FORBIDDEN'

export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  const t = useTranslations('common')
  const te = useTranslations('errors')

  useEffect(() => {
    // Next already logs this server-side; this is what makes it visible in the
    // browser console during development, where most of these are found.
    console.error(error)
  }, [error])

  const refused = error.digest === REFUSAL_DIGEST

  return (
    <div className="flex min-h-[60svh] items-center justify-center">
      <Card className="w-full max-w-md">
        <CardContent className="flex flex-col items-center gap-3 py-10 text-center">
          <span
            aria-hidden
            className={
              refused
                ? 'grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground'
                : 'grid size-11 place-items-center rounded-xl bg-destructive/10 text-destructive'
            }
          >
            {refused ? <ShieldOff className="size-5" /> : <TriangleAlert className="size-5" />}
          </span>

          <p role="alert" className="font-medium">
            {refused ? te('forbiddenTitle') : t('somethingWentWrong')}
          </p>
          <p className="text-sm text-balance text-muted-foreground">
            {refused ? te('forbidden') : te('unexpected')}
          </p>

          <div className="flex flex-wrap justify-center gap-2 pt-2">
            {/* Retrying a refusal cannot succeed — see the box above. */}
            {!refused && (
              <Button variant="outline" size="sm" onClick={reset}>
                <RefreshCw />
                {t('retry')}
              </Button>
            )}
            <Link href="/dashboard" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
              {t('back')}
            </Link>
          </div>

          {/* The digest identifies THIS occurrence in the server log. It is
              meaningless for a refusal, which is expected behaviour rather
              than something anybody will go looking for. */}
          {!refused && error.digest && (
            <p className="pt-2 font-mono text-xs text-muted-foreground">{error.digest}</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
