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
  throw new Error(`Invalid public environment configuration:\n${issues}\n\nCopy .env.example to .env.local and fill it in.`)
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
