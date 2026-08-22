'use server'

import { z } from 'zod'
import { headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { routing } from '@/lib/i18n/routing'

/**
 * Authentication actions.
 *
 * Every one returns a plain `{ ok, error }` rather than throwing, because these
 * are bound to forms via useActionState and a thrown error there becomes an
 * unstyled error boundary rather than a field message.
 */

export interface ActionResult {
  ok: boolean
  error?: string
  message?: string
}

const localeSchema = z.enum(routing.locales)

/** Absolute origin for email redirect links. Derived from the request rather
 *  than an env var so preview deployments send links back to themselves. */
async function origin(): Promise<string> {
  const h = await headers()
  const host = h.get('x-forwarded-host') ?? h.get('host') ?? 'localhost:3000'
  const proto = h.get('x-forwarded-proto') ?? (host.startsWith('localhost') ? 'http' : 'https')
  return `${proto}://${host}`
}

// ── Registration ─────────────────────────────────────────────────────────────

const registerSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  password: z
    .string()
    .min(8, 'Password must be at least 8 characters.')
    // Length only. Composition rules (a symbol, a digit, a capital) push people
    // toward Password1! and are worse than a longer passphrase. NIST dropped
    // them years ago; so do we.
    .max(128, 'Password is too long.'),
  confirm: z.string(),
  fullName: z.string().trim().min(2, 'Enter your full name.').max(120),
  phone: z.string().trim().max(20).optional().or(z.literal('')),
  /** The URL's locale. Decides where the redirect below lands, and nothing else. */
  locale: localeSchema.default('en'),
  /**
   * What the person actually picked, and what their profile is created with.
   * The form has always rendered this select and the action has always ignored
   * it — see the box in register-form.tsx. Falls back to the URL's locale when
   * absent, which is what the old behaviour was for everybody.
   */
  preferredLocale: localeSchema.optional(),
})
  .refine((v) => v.password === v.confirm, {
    message: 'Those passwords do not match.',
  })

/**
 * SECURITY: the schema above has no role, no outlet, no approval_status, and
 * no company. Everything passed here lands in raw_user_meta_data, which is
 * client-controlled — the handle_new_user trigger (migration 0003) reads only
 * display fields from it and hard-codes approval_status to 'pending'.
 *
 * Outlet and department are collected in the UI but applied by a chef during
 * approval, not written from the signup payload. A user must not be able to
 * assert which outlet they belong to.
 */
export async function registerAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = registerSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    confirm: formData.get('confirm'),
    fullName: formData.get('fullName'),
    phone: formData.get('phone') ?? '',
    locale: formData.get('locale') ?? 'en',
    preferredLocale: formData.get('preferredLocale') ?? undefined,
  })

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' }
  }

  const { email, password, fullName, phone, locale, preferredLocale } = parsed.data
  const supabase = await createClient()

  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      /*
       * ┌───────────────────────────────────────────────────────────────────────┐
       * │ THIS POINTED AT /{locale}/auth/confirm, WHICH DID NOT EXIST.          │
       * │                                                                       │
       * │ mailer_autoconfirm is false on this project — verified against        │
       * │ /auth/v1/settings, not assumed — so signUp sends a confirmation mail  │
       * │ and establishes no session. Every one of those mails carried a link   │
       * │ to a 404, so a registrant could never confirm and could never sign    │
       * │ in. Signup was a dead end for the whole life of the product.          │
       * │                                                                       │
       * │ The route now exists, AND the primary flow is a 6-digit code typed    │
       * │ on /verify-email. Both are supported deliberately: which one the      │
       * │ email carries is decided by a template in the Supabase dashboard,     │
       * │ not by this file, and supporting only one fails silently and in       │
       * │ production the day somebody edits the other.                          │
       * └───────────────────────────────────────────────────────────────────────┘
       */
      emailRedirectTo: `${await origin()}/${locale}/auth/confirm`,
      // `locale` here is what handle_new_user (0003) writes to
      // profiles.preferred_locale — it validates the value against the three
      // supported codes and falls back to 'en', so nothing client-supplied
      // reaches the column unchecked.
      data: { full_name: fullName, phone: phone || null, locale: preferredLocale ?? locale },
    },
  })

  if (error) {
    /*
     * ╔═══════════════════════════════════════════════════════════════════════════╗
     * ║ THE RATE LIMIT IS NAMED, AND EVERYTHING ELSE IS NOT.                      ║
     * ║                                                                           ║
     * ║ "user already registered" stays deliberately vague: distinguishing it     ║
     * ║ turns this form into an account-enumeration oracle — anyone could test    ║
     * ║ whether a colleague has an account.                                       ║
     * ║                                                                           ║
     * ║ over_email_send_rate_limit is different in kind, and it is REAL on this   ║
     * ║ project. The built-in SMTP allows a couple of messages an hour, and       ║
     * ║ registering three people in one sitting produced:                         ║
     * ║                                                                           ║
     * ║   429 {"error_code":"over_email_send_rate_limit",                         ║
     * ║        "msg":"email rate limit exceeded"}                                 ║
     * ║                                                                           ║
     * ║ Under the generic message that reads as "check your details", so the      ║
     * ║ person retypes a correct form until they give up — and the manager        ║
     * ║ onboarding a shift of new staff concludes signup is broken. It reveals    ║
     * ║ nothing about any account: it is a property of the project, and it is     ║
     * ║ already visible to anyone who registers twice.                            ║
     * ║                                                                           ║
     * ║ The real fix is custom SMTP on the project. This makes the wait legible   ║
     * ║ until then.                                                               ║
     * ╚═══════════════════════════════════════════════════════════════════════════╝
     */
    if (/rate limit/i.test(error.message) || error.status === 429) {
      return {
        ok: false,
        error: 'Too many accounts have been created just now. Wait a few minutes and try again.',
      }
    }

    return { ok: false, error: 'Could not complete registration. Check your details and try again.' }
  }

  /*
   * Straight to the code screen, carrying the address.
   *
   * Not a success panel with "check your email": there is nowhere to type the
   * code from there, and the address has to reach /verify-email somehow. There
   * is no session yet — mailer_autoconfirm is false — so a cookie is not
   * available and the query string is the only channel.
   *
   * Putting an email address in a URL is a real cost (browser history, server
   * logs, a shared screen) and it is accepted here because the alternative is
   * asking somebody who has just typed their address to type it again. It is
   * not a credential: possession of the address grants nothing without the
   * code, which is emailed to that address.
   */
  redirect(`/${locale}/verify-email?email=${encodeURIComponent(email)}`)
}

// ── Email verification ───────────────────────────────────────────────────────

const verifySchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  /*
   * ╔═══════════════════════════════════════════════════════════════════════════╗
   * ║ THE CODE IS NOT SIX DIGITS ON THIS PROJECT. IT IS EIGHT.                  ║
   * ║                                                                           ║
   * ║ This was written as /^\d{6}$/ because six is what every article about     ║
   * ║ email OTP says. Asking the live auth server produced 67660187, 98219925   ║
   * ║ and 89068002 — all eight. A six-digit rule would have rejected every      ║
   * ║ real code before it ever reached Supabase, and the screen would have      ║
   * ║ said "enter the 6-digit code" to somebody holding eight.                  ║
   * ║                                                                           ║
   * ║ The length is a dashboard setting (Email OTP Length) that this app has    ║
   * ║ no way to read at runtime — it is not in /auth/v1/settings. So the rule   ║
   * ║ is deliberately loose: digits, of a plausible length. GoTrue is the       ║
   * ║ authority on whether the code is right; this only stops an obviously      ║
   * ║ empty or pasted-wrong field from becoming a round trip.                   ║
   * ╚═══════════════════════════════════════════════════════════════════════════╝
   */
  token: z
    .string()
    .trim()
    .regex(/^\d{4,12}$/, 'Enter the code from your email.'),
  locale: localeSchema.default('en'),
})

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Confirming the address with the emailed code.
 *
 * ON SUCCESS THIS ESTABLISHES A SESSION, which is why it is an action and not
 * done during render: a Server Component cannot set cookies (server.ts
 * swallows exactly that failure in its setAll), so the same call in a page
 * would appear to work and leave the user with no session at all.
 *
 * The freshly minted token already carries email_verified=true from the 0070
 * hook, so the proxy lets them through on the very next request. No refresh
 * handshake is needed here — unlike approval, which is granted by somebody
 * else, long after the token was minted.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export async function verifyEmailAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = verifySchema.safeParse({
    email: formData.get('email'),
    token: formData.get('token'),
    locale: formData.get('locale') ?? 'en',
  })

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Enter the 6-digit code from your email.' }
  }

  const { email, token, locale } = parsed.data
  const supabase = await createClient()

  // type 'email', which GoTrue accepts for a signup confirmation code — checked
  // against the live server rather than read off the type union, because
  // EmailOtpType offers both 'signup' and 'email' and only one of them being
  // right would be a production-only failure.
  const { error } = await supabase.auth.verifyOtp({ email, token, type: 'email' })

  if (error) {
    /*
     * ┌───────────────────────────────────────────────────────────────────────┐
     * │ ONE MESSAGE, BECAUSE THE SERVER GIVES ONE ANSWER.                     │
     * │                                                                       │
     * │ This branched on /expired/ to say either "that code has expired" or   │
     * │ "that code is not right". GoTrue answers a WRONG code with exactly    │
     * │ the same thing it answers an expired one:                             │
     * │                                                                       │
     * │   403 {"error_code":"otp_expired",                                    │
     * │        "msg":"Token has expired or is invalid"}                       │
     * │                                                                       │
     * │ So the branch would have told everybody who mistyped a digit that     │
     * │ their code had expired, sending them to request a new one they did    │
     * │ not need — and the message would have been confidently wrong, which   │
     * │ is worse than vague.                                                  │
     * │                                                                       │
     * │ The screen carries a "send a new code" button next to this, so the    │
     * │ remedy for both cases is one tap away without having to name which    │
     * │ case it is.                                                           │
     * └───────────────────────────────────────────────────────────────────────┘
     */
    return {
      ok: false,
      error: 'That code did not work. It may have expired — check the email, or ask for a new code.',
    }
  }

  // Verified, but not yet approved by a manager — /pending is the next stop,
  // and it redirects onward by itself the moment approval lands.
  redirect(`/${locale}/pending`)
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The verification counterpart of checkApprovalStatus().
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ WITHOUT THIS, MIGRATION 0070 STRANDS ANYBODY HOLDING AN OLDER TOKEN.      ║
 * ║                                                                           ║
 * ║ A token minted before 0070 carries no email_verified, and can.ts defaults ║
 * ║ the missing field to false — correctly, because failing closed is the     ║
 * ║ only safe reading of an absent claim. The (app) layout therefore sends    ║
 * ║ its holder to /verify-email.                                             ║
 * ║                                                                           ║
 * ║ Their address is ALREADY confirmed, so there is no code coming and        ║
 * ║ verifyOtp() would refuse one. Without this action they would sit on a     ║
 * ║ screen whose only exit is to work out for themselves that signing out     ║
 * ║ and back in fixes it.                                                     ║
 * ║                                                                           ║
 * ║ Same shape as the approval handshake in /pending, for the same reason:    ║
 * ║ read the AUTHORITY (auth.users, via getUser) rather than the stale claim, ║
 * ║ then let the client call refreshSession() to mint a token that agrees.    ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * getUser() and not getSession(): getSession trusts the cookie without checking
 * it against the auth server, and this decides whether somebody walks past a
 * gate.
 */
export async function checkEmailVerified(): Promise<{ signedIn: boolean; verified: boolean }> {
  const supabase = await createClient()
  const { data, error } = await supabase.auth.getUser()

  if (error || !data.user) return { signedIn: false, verified: false }
  return { signedIn: true, verified: Boolean(data.user.email_confirmed_at) }
}

const resendSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
})

/**
 * Sends another code.
 *
 * The response is the same whether or not the address is registered, and
 * whether or not GoTrue rate-limited the request. This endpoint is reachable
 * without a session, so a distinguishable answer would make it an
 * account-enumeration oracle — the same reasoning as forgotPasswordAction.
 */
export async function resendOtpAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = resendSchema.safeParse({ email: formData.get('email') })

  if (!parsed.success) {
    return { ok: false, error: 'Enter a valid email address.' }
  }

  const supabase = await createClient()
  await supabase.auth.resend({ type: 'signup', email: parsed.data.email })

  return { ok: true, message: 'A new code is on its way.' }
}

// ── Sign in ──────────────────────────────────────────────────────────────────

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  password: z.string().min(1, 'Enter your password.'),
  next: z.string().optional(),
  locale: localeSchema.default('en'),
})

export async function loginAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = loginSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
    next: formData.get('next') ?? undefined,
    locale: formData.get('locale') ?? 'en',
  })

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' }
  }

  const { email, password, next, locale } = parsed.data
  const supabase = await createClient()

  const { error } = await supabase.auth.signInWithPassword({ email, password })

  if (error) {
    // One message for both wrong-password and no-such-user, again to avoid
    // account enumeration.
    return { ok: false, error: 'That email and password combination is not recognised.' }
  }

  // Only same-origin relative paths. An open redirect here would let a phishing
  // link bounce through a legitimate login page to an attacker's site.
  const safeNext =
    next && next.startsWith('/') && !next.startsWith('//') ? next : `/${locale}/dashboard`

  redirect(safeNext)
}

// ── Sign out ─────────────────────────────────────────────────────────────────

export async function logoutAction(locale: string = 'en'): Promise<never> {
  const supabase = await createClient()
  await supabase.auth.signOut()
  redirect(`/${locale}/login`)
}

// ── Password reset ───────────────────────────────────────────────────────────

const forgotSchema = z.object({
  email: z.string().trim().toLowerCase().email('Enter a valid email address.'),
  locale: localeSchema.default('en'),
})

export async function forgotPasswordAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = forgotSchema.safeParse({
    email: formData.get('email'),
    locale: formData.get('locale') ?? 'en',
  })

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Enter a valid email address.' }
  }

  const { email, locale } = parsed.data
  const supabase = await createClient()

  await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${await origin()}/${locale}/reset-password`,
  })

  // Always the same response, error or not — otherwise this endpoint reports
  // which addresses are registered.
  return {
    ok: true,
    message: 'If that email is registered, a reset link is on its way.',
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Completing a reset.
 *
 * forgotPasswordAction has always pointed its email at
 * `/{locale}/reset-password`, and that route did not exist — so every reset
 * link this application has ever sent landed on a 404. These two actions and
 * the page under (auth)/reset-password are what close that loop.
 *
 * WHY THE EXCHANGE IS AN ACTION AND NOT DONE IN THE PAGE.
 *
 * Both paths below establish a session, which means writing auth cookies. A
 * Server Component cannot set cookies — server.ts swallows exactly that failure
 * in its setAll — so doing this during render would appear to succeed and leave
 * the user with no session. A Server Action can, so the page renders first and
 * the client calls this.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export async function exchangeRecoveryLink(input: {
  code?: string
  tokenHash?: string
}): Promise<ActionResult> {
  const supabase = await createClient()

  // Two link shapes, because which one arrives depends on the project's email
  // template rather than on anything this code controls. `{{ .ConfirmationURL }}`
  // produces a PKCE `?code=`; `{{ .TokenHash }}` produces `?token_hash=&type=`.
  // Supporting one and not the other fails invisibly, in production, on a
  // template change nobody connected to this file.
  if (input.code) {
    const { error } = await supabase.auth.exchangeCodeForSession(input.code)
    // Deliberately not surfaced verbatim. The common causes — expired, already
    // used, opened in a different browser from the one that asked — are all
    // answered by the same instruction, and Supabase's wording for them is not
    // something to show a line cook.
    if (error) return { ok: false }
    return { ok: true }
  }

  if (input.tokenHash) {
    const { error } = await supabase.auth.verifyOtp({
      type: 'recovery',
      token_hash: input.tokenHash,
    })
    if (error) return { ok: false }
    return { ok: true }
  }

  return { ok: false }
}

const resetSchema = z
  .object({
    // Same rule as registration: length only. See registerSchema.
    password: z.string().min(8, 'Password must be at least 8 characters.').max(128, 'Password is too long.'),
    confirm: z.string(),
  })
  .refine((v) => v.password === v.confirm, {
    message: 'Those passwords do not match.',
  })

/**
 * Sets the new password.
 *
 * Relies on the recovery session established by exchangeRecoveryLink — there is
 * no token here, and there must not be. updateUser acts on whoever the cookie
 * says is signed in, so a request without a valid recovery session changes
 * nothing and returns an error rather than falling through to some default.
 */
export async function resetPasswordAction(
  _prev: ActionResult | null,
  formData: FormData,
): Promise<ActionResult> {
  const parsed = resetSchema.safeParse({
    password: formData.get('password'),
    confirm: formData.get('confirm'),
  })

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' }
  }

  const supabase = await createClient()

  // getUser(), not getSession(): getSession trusts the cookie without checking
  // it against the auth server, which would let a forged cookie reach a
  // password change. The same rule server.ts states.
  const { data: userData, error: userError } = await supabase.auth.getUser()
  if (userError || !userData.user) {
    return { ok: false, error: 'This reset link is no longer valid. Ask for a new one.' }
  }

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password })
  if (error) {
    return { ok: false, error: 'That password could not be saved. Try a different one.' }
  }

  /*
   * ┌───────────────────────────────────────────────────────────────────────────┐
   * │ END THE RECOVERY SESSION. IT IS NOT A LOGIN.                              │
   * │                                                                           │
   * │ exchangeRecoveryLink() establishes a real session so updateUser() has      │
   * │ somebody to act on, and this action used to leave it standing. The result: │
   * │ whoever opened that emailed link stayed signed in on that device           │
   * │ indefinitely — on the one flow whose whole premise is that the account     │
   * │ may have been compromised.                                                 │
   * │                                                                           │
   * │ It also silently undoes the change on every OTHER device, which is the     │
   * │ behaviour people expect from "I changed my password" and did not get.      │
   * │                                                                           │
   * │ scope 'global', not the default 'local': the point is the sessions this    │
   * │ browser cannot see.                                                        │
   * └───────────────────────────────────────────────────────────────────────────┘
   */
  await supabase.auth.signOut({ scope: 'global' })

  return { ok: true }
}

// ── Approval status poll ─────────────────────────────────────────────────────

/**
 * Reads approval status straight from `profiles` via the me_status() RPC,
 * bypassing the JWT claim.
 *
 * WHY THIS EXISTS: claims are baked at token mint. A user approved thirty
 * seconds ago still carries approved=false until their token refreshes, so the
 * /pending page cannot simply re-read the session — it would show "awaiting
 * approval" to someone already approved, for up to the full token lifetime.
 * This reads the table, and the page then calls refreshSession() to mint a
 * token carrying the new claim. See migration 0004 and plan §5.5.
 */
export async function checkApprovalStatus(): Promise<{
  status: 'pending' | 'approved' | 'rejected' | 'suspended' | 'unknown'
  reason?: string | null
}> {
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('me_status')

  if (error || !data || (Array.isArray(data) && data.length === 0)) {
    return { status: 'unknown' }
  }

  // Casts are needed only while database.types.ts is the permissive placeholder.
  // Once `gen:types` runs against the linked project, me_status()'s return type
  // is known exactly and these can go.
  const row = (Array.isArray(data) ? data[0] : data) as {
    approval_status?: string
    rejection_reason?: string | null
  }

  return {
    status: (row.approval_status ?? 'unknown') as 'pending' | 'approved' | 'rejected' | 'suspended',
    reason: row.rejection_reason ?? null,
  }
}
