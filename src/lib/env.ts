import { z } from 'zod'

/**
 * Environment access, validated once at module load.
 *
 * Why bother: a missing or misspelled Supabase key otherwise surfaces as an
 * opaque 401 from PostgREST three layers deep. Failing loudly at boot with the
 * variable name is worth the twenty lines.
 *
 * NOTE: `process.env.NEXT_PUBLIC_*` must be written as a full literal
 * expression — Next.js statically replaces these strings at build time, so
 * `process.env[someKey]` silently yields undefined in the browser.
 */

const publicSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z
    .string()
    .url('NEXT_PUBLIC_SUPABASE_URL must be a full URL, e.g. https://abc.supabase.co'),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z
    .string()
    .min(1, 'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY is required'),
})

const parsedPublic = publicSchema.safeParse({
  NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
})

if (!parsedPublic.success) {
  const issues = parsedPublic.error.issues.map((i) => `  - ${i.message}`).join('\n')
  /*
   * THROWING HERE FAILS `next build` TOO, AND THAT IS CORRECT. NEXT_PUBLIC_*
   * values are inlined into the client bundle at build time — a build without
   * them would ship an app whose browser half talks to `undefined`, failing
   * at runtime in ways nothing traces back to configuration. Refusing the
   * build is the guard working, not a bug in it.
   *
   * The message names both places the fix lives, because this fired once on a
   * freshly created Render service that had no environment at all, and the
   * old text ("copy .env.example to .env.local") pointed at the wrong one.
   */
  throw new Error(
    `Invalid public environment configuration:\n${issues}\n\n` +
      `Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.\n` +
      `  · Local development: copy .env.example to .env.local and fill it in.\n` +
      `  · Hosted (Render etc.): add them under the service's Environment settings,\n` +
      `    then redeploy — they are baked in at BUILD time, so a restart is not enough.`,
  )
}

export const env = parsedPublic.data

/**
 * Server-only secret. Read lazily rather than at module load so that importing
 * anything from this file in a client component does not blow up the build —
 * the guard below is the real protection.
 *
 * This key bypasses Row-Level Security completely. See src/lib/supabase/admin.ts.
 */
export function getSecretKey(): string {
  if (typeof window !== 'undefined') {
    throw new Error('SUPABASE_SECRET_KEY was read in the browser. This is a security bug — check the import chain.')
  }
  const key = process.env.SUPABASE_SECRET_KEY
  if (!key) {
    throw new Error('SUPABASE_SECRET_KEY is not set. Add it to .env.local (never commit it).')
  }
  return key
}

/**
 * ─────────────────────────────────────────────────────────────────────────────
 * Email secrets.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ LAZY, AND THAT IS NOT A STYLE CHOICE.                                     │
 * │                                                                           │
 * │ Reading these at module load would throw during import, and an import      │
 * │ throw takes down every route that touches the module — which is exactly    │
 * │ how one unset variable turned /register into a 500 while every other auth  │
 * │ page served normally. Migration 0081 exists to undo that failure mode; do  │
 * │ not reintroduce it here.                                                   │
 * │                                                                           │
 * │ Read inside the function that sends, so a missing key fails one drain run  │
 * │ and is recorded in email_outbox.last_error, rather than breaking pages     │
 * │ that have nothing to do with email.                                        │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

function serverOnly(name: string): void {
  if (typeof window !== 'undefined') {
    throw new Error(`${name} was read in the browser. This is a security bug — check the import chain.`)
  }
}

/** Resend API key. Sends mail; never reaches the client. */
export function getResendApiKey(): string {
  serverOnly('RESEND_API_KEY')
  const key = process.env.RESEND_API_KEY
  if (!key) {
    throw new Error('RESEND_API_KEY is not set. Add it to .env.local (never commit it).')
  }
  return key
}

/**
 * The From address.
 *
 * Not a secret, but it belongs beside the key because the two must agree:
 * Resend refuses any sender it has not authorised, and returns the same opaque
 * failure whether the key is wrong or the domain is unverified. Until a domain
 * is verified this must be onboarding@resend.dev.
 */
export function getEmailFrom(): string {
  serverOnly('EMAIL_FROM')
  const from = process.env.EMAIL_FROM
  if (!from) {
    throw new Error('EMAIL_FROM is not set. Use onboarding@resend.dev until a domain is verified.')
  }
  return from
}

/**
 * Shared secret for the drain endpoint.
 *
 * The route is reachable from the public internet, and draining is a
 * side-effecting operation that spends a metered quota. Compared timing-safely
 * at the callsite — see the route.
 */
export function getCronSecret(): string {
  serverOnly('CRON_SECRET')
  const secret = process.env.CRON_SECRET
  if (!secret) {
    throw new Error('CRON_SECRET is not set. Add it to .env.local and to the cron caller.')
  }
  return secret
}
