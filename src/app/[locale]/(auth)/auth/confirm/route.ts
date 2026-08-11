import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { routing } from '@/lib/i18n/routing'
import type { EmailOtpType } from '@supabase/supabase-js'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Where a confirmation LINK lands.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THIS ROUTE HAD NEVER EXISTED, AND registerAction HAD ALWAYS POINTED AT IT.║
 * ║                                                                           ║
 * ║ signUp({ options: { emailRedirectTo: `…/${locale}/auth/confirm` } }) has  ║
 * ║ been in the register action since M0. mailer_autoconfirm is false on this ║
 * ║ project — read from /auth/v1/settings, not assumed — so every signup      ║
 * ║ genuinely sent that mail, and every link in it 404'd. Nobody who          ║
 * ║ registered through the product could confirm, and GoTrue refuses          ║
 * ║ sign-in for an unconfirmed address, so nobody who registered could sign   ║
 * ║ in either. Signup was a dead end end-to-end.                              ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * WHY IT EXISTS ALONGSIDE THE CODE SCREEN. Which of the two arrives is decided
 * by the "Confirm signup" email template in the Supabase dashboard —
 * `{{ .ConfirmationURL }}` sends a link, `{{ .Token }}` sends a code — and
 * that is not a decision this repository can make or even read. Supporting one
 * shape only means the day somebody edits that template, signup breaks in
 * production with nothing in the code having changed. Both work.
 *
 * A ROUTE HANDLER, NOT A PAGE: confirming establishes a session, which means
 * writing cookies. A Server Component cannot — server.ts swallows exactly that
 * failure in its setAll — so a page here would appear to succeed and leave the
 * visitor with no session.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** The types GoTrue may send here. Anything else is not ours to act on. */
const ALLOWED: readonly EmailOtpType[] = ['signup', 'invite', 'magiclink', 'email', 'email_change']

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ locale: string }> },
) {
  const { locale: rawLocale } = await params
  const locale = (routing.locales as readonly string[]).includes(rawLocale)
    ? rawLocale
    : routing.defaultLocale

  const url = request.nextUrl
  const to = (path: string, search = '') =>
    NextResponse.redirect(new URL(`/${locale}${path}${search}`, url.origin))

  /*
   * Supabase reports a dead link by redirecting back with ?error= — sometimes
   * ALONGSIDE a code. Checking the code first would try to exchange one that
   * has already been rejected, and report the failure as a server problem
   * rather than as an expired link. The same trap reset-password documents.
   */
  if (url.searchParams.get('error') || url.searchParams.get('error_code')) {
    return to('/verify-email', '?expired=1')
  }

  const supabase = await createClient()

  // Two link shapes, for the same reason exchangeRecoveryLink handles two:
  // `{{ .ConfirmationURL }}` produces a PKCE `?code=`, `{{ .TokenHash }}`
  // produces `?token_hash=&type=`.
  const code = url.searchParams.get('code')
  const tokenHash = url.searchParams.get('token_hash')
  const type = url.searchParams.get('type') as EmailOtpType | null

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (error) return to('/verify-email', '?expired=1')
    return to('/pending')
  }

  if (tokenHash && type && ALLOWED.includes(type)) {
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type })
    if (error) return to('/verify-email', '?expired=1')
    // email_change lands somebody who is already signed in back in the app;
    // everything else is a new account, which waits for a manager.
    return to(type === 'email_change' ? '/dashboard' : '/pending')
  }

  // No code, no token, no error: somebody typed the URL. Nothing to confirm.
  return to('/login')
}
