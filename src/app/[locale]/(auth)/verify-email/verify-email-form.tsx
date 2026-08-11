'use client'

import { useActionState, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { Loader2, Mail, MailCheck } from 'lucide-react'
import {
  checkEmailVerified,
  resendOtpAction,
  verifyEmailAction,
  type ActionResult,
} from '@/server/actions/auth'
import { createClient } from '@/lib/supabase/client'
import { Link, useRouter } from '@/lib/i18n/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { InlineError } from '@/components/ui/inline-error'

const COOLDOWN_SECONDS = 60

/**
 * Masks the local part, keeping enough to recognise but not enough to publish.
 *
 * `mspatel05831@gmail.com` → `ms•••••@gmail.com`. Shown because somebody who
 * mistyped their address needs to find that out HERE, while they still remember
 * what they typed — not after ten minutes of waiting for a mail that went to a
 * stranger. Short local parts are not padded out to a fixed width, which would
 * imply characters that are not there.
 */
function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at < 1) return email
  const local = email.slice(0, at)
  const domain = email.slice(at)
  if (local.length <= 2) return `${local[0]}•${domain}`
  return `${local.slice(0, 2)}${'•'.repeat(Math.min(local.length - 2, 6))}${domain}`
}

export function VerifyEmailForm({
  locale,
  email,
  linkExpired,
}: {
  locale: string
  email: string
  linkExpired: boolean
}) {
  const t = useTranslations('auth.verifyEmail')
  const tc = useTranslations('common')

  const router = useRouter()

  const [state, formAction, pending] = useActionState<ActionResult | null, FormData>(
    verifyEmailAction,
    null,
  )

  /*
   * ┌───────────────────────────────────────────────────────────────────────────┐
   * │ THE STALENESS HANDSHAKE, IDENTICAL IN SHAPE TO /pending's.                │
   * │                                                                           │
   * │ Two people land here who should not have to type anything:                │
   * │                                                                           │
   * │   · anyone holding a token minted before migration 0070, which carries no │
   * │     email_verified at all — the claim schema defaults it to false, so the │
   * │     layout sends them here even though their address was confirmed months │
   * │     ago and no code is coming                                             │
   * │   · anyone who confirmed in a second tab, or by clicking the link         │
   * │                                                                           │
   * │ Both are answered by asking the auth server what is actually true,        │
   * │ refreshing the session so the token agrees, and moving on. Without the    │
   * │ refresh the claim stays false and the layout sends them straight back —   │
   * │ the same redirect loop 0004 documents for approval, in a new place.       │
   * │                                                                           │
   * │ IT DOES NOT GATE THE FORM. An earlier version hid the code field behind a │
   * │ `settling` flag until this resolved, which meant a failed action or a     │
   * │ page whose JavaScript never arrived showed a spinner and nothing else —   │
   * │ trading a brief flash for a screen with no way forward. The form renders  │
   * │ immediately and this quietly overtakes it when it applies.                │
   * └───────────────────────────────────────────────────────────────────────────┘
   */
  useEffect(() => {
    let cancelled = false
    void (async () => {
      const { signedIn, verified } = await checkEmailVerified()
      if (cancelled || !signedIn || !verified) return
      await createClient().auth.refreshSession()
      router.replace('/dashboard')
    })()
    return () => {
      cancelled = true
    }
  }, [router])
  /*
   * The cooldown is a COURTESY, NOT A CONTROL.
   *
   * It exists so the button stops inviting taps that GoTrue will rate-limit
   * anyway, and so a person who has just asked for a code is told to wait
   * rather than left wondering whether the tap registered. Anyone can bypass it
   * by reloading the page; the real limit is on Supabase's side, which is where
   * a rate limit belongs. Nothing here is relied on for security.
   */
  const [cooldown, setCooldown] = useState(0)

  useEffect(() => {
    if (cooldown <= 0) return
    // In the timeout callback, not the effect body — the effect only arms it.
    const id = setTimeout(() => setCooldown((s) => s - 1), 1000)
    return () => clearTimeout(id)
  }, [cooldown])

  /*
   * The cooldown starts INSIDE the action, not in an effect watching its
   * result. Watching the result meant calling setState synchronously in an
   * effect body — cascading renders — and it needed a ref to tell a new result
   * apart from a re-render of the same one, which is a lot of machinery for
   * "the button was just pressed". Here the press and the deadline are one
   * event. (Declared after the state it sets, so the closure does not reach
   * backwards over its own declaration.)
   */
  const [resendState, resendAction, resending] = useActionState<ActionResult | null, FormData>(
    async (previous, formData) => {
      const result = await resendOtpAction(previous, formData)
      if (result.ok) setCooldown(COOLDOWN_SECONDS)
      return result
    },
    null,
  )

  /*
   * ╔═══════════════════════════════════════════════════════════════════════════╗
   * ║ ONE FIELD, NOT SIX BOXES — AND THE REASON IS MEASURED, NOT AESTHETIC.     ║
   * ║                                                                           ║
   * ║ The design called for six single-character inputs with auto-advance. Then ║
   * ║ the live auth server was asked what a real code looks like:               ║
   * ║                                                                           ║
   * ║   67660187   98219925   89068002                                          ║
   * ║                                                                           ║
   * ║ Eight digits, not six. The length comes from the Email OTP Length setting ║
   * ║ in the Supabase dashboard, and it is NOT exposed on /auth/v1/settings —   ║
   * ║ so this app cannot know it at runtime. Six boxes would have been unable   ║
   * ║ to accept a single real code, and would silently break again the day      ║
   * ║ somebody changed that setting.                                            ║
   * ║                                                                           ║
   * ║ One field of any length cannot be wrong about that. It also pastes        ║
   * ║ cleanly, works with autoComplete="one-time-code" autofill, and reads as   ║
   * ║ one labelled control to a screen reader instead of six unlabelled ones.   ║
   * ╚═══════════════════════════════════════════════════════════════════════════╝
   */
  if (!email) {
    /*
     * No address: a bookmark, a link opened in another browser, or /auth/confirm
     * bouncing a dead link here — that redirect cannot carry the address,
     * because Supabase's error response does not include it.
     *
     * A PLAIN GET FORM BACK TO THIS PAGE, deliberately. No action, no state, no
     * JavaScript: it only needs to put ?email= in the URL, which is the one
     * thing a <form method="get"> does natively. Routing this through a Server
     * Action would make the recovery path from a broken link depend on the
     * client bundle having loaded.
     */
    return (
      <form method="get" className="space-y-4">
        {linkExpired ? <InlineError>{t('linkExpired')}</InlineError> : null}

        <div className="space-y-2">
          <Label htmlFor="email">{t('emailLabel')}</Label>
          <div className="relative">
            <Mail
              aria-hidden
              className="pointer-events-none absolute inset-y-0 left-3 my-auto size-4 text-muted-foreground"
            />
            <Input
              id="email"
              name="email"
              type="email"
              inputMode="email"
              autoComplete="email"
              required
              autoFocus
              className="pl-9"
            />
          </div>
          <p className="text-xs text-muted-foreground">{t('noAddress')}</p>
        </div>

        <Button type="submit" size="lg" className="w-full">
          {t('continue')}
        </Button>

        <Link
          href="/login"
          className="block text-center text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          {t('backToSignIn')}
        </Link>
      </form>
    )
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-col items-center gap-2 text-center">
        <span aria-hidden className="grid size-11 place-items-center rounded-xl bg-info/12 text-info">
          <Mail className="size-5" />
        </span>
        <p className="text-sm text-muted-foreground text-balance">
          {t('sentTo')} <span className="font-medium text-foreground">{maskEmail(email)}</span>
        </p>
      </div>

      <form action={formAction} className="space-y-4">
        <input type="hidden" name="locale" value={locale} />
        <input type="hidden" name="email" value={email} />

        {linkExpired && !state?.error ? <InlineError>{t('linkExpired')}</InlineError> : null}
        {state?.error && <InlineError>{state.error}</InlineError>}

        <div className="space-y-2">
          <Label htmlFor="token">{t('codeLabel')}</Label>
          <Input
            id="token"
            name="token"
            // text, not number: type="number" gives a spinner, strips leading
            // zeros on some browsers, and a code beginning 0 would arrive short.
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="one-time-code"
            // Long enough for any plausible dashboard setting, short enough to
            // stop a paste of the whole email.
            maxLength={12}
            required
            autoFocus
            disabled={pending}
            aria-describedby="token-hint"
            className="text-center text-lg tracking-[0.4em] font-mono"
          />
          <p id="token-hint" className="text-xs text-muted-foreground">
            {t('codeHint')}
          </p>
        </div>

        <Button type="submit" size="lg" className="w-full" disabled={pending}>
          {pending && <Loader2 className="animate-spin" />}
          {pending ? tc('loading') : t('submit')}
        </Button>
      </form>

      {/* A separate form: resending must not carry the half-typed code with it,
          and useActionState wants one action per form. */}
      <form action={resendAction} className="space-y-2">
        <input type="hidden" name="email" value={email} />

        {resendState?.ok && (
          <p role="status" className="flex items-center justify-center gap-2 text-sm text-success">
            <MailCheck aria-hidden className="size-4" />
            {resendState.message}
          </p>
        )}

        <Button
          type="submit"
          variant="outline"
          className="w-full"
          disabled={resending || cooldown > 0}
        >
          {resending && <Loader2 className="animate-spin" />}
          {cooldown > 0 ? t('resendIn', { seconds: cooldown }) : t('resend')}
        </Button>
      </form>

      <div className="space-y-1">
        <Link
          href="/register"
          className="block text-center text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          {t('wrongAddress')}
        </Link>
        <Link
          href="/login"
          className="block text-center text-sm text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
        >
          {t('backToSignIn')}
        </Link>
      </div>
    </div>
  )
}
