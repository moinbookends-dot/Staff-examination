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
  fullName: z.string().trim().min(2, 'Enter your full name.').max(120),
  phone: z.string().trim().max(20).optional().or(z.literal('')),
  locale: localeSchema.default('en'),
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
    fullName: formData.get('fullName'),
    phone: formData.get('phone') ?? '',
    locale: formData.get('locale') ?? 'en',
  })

  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' }
  }

  const { email, password, fullName, phone, locale } = parsed.data
  const supabase = await createClient()

  const { error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      emailRedirectTo: `${await origin()}/${locale}/auth/confirm`,
      data: { full_name: fullName, phone: phone || null, locale },
    },
  })

  if (error) {
    // Deliberately vague on "user already registered". Distinguishing it turns
    // the signup form into an account-enumeration oracle — anyone could test
    // whether a given colleague has an account.
    return { ok: false, error: 'Could not complete registration. Check your details and try again.' }
  }

  return {
    ok: true,
    message: 'Check your email for a verification link. A manager will approve your account shortly after.',
  }
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
