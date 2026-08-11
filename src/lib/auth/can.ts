import { z } from 'zod'
import { dbId } from '@/lib/db/id'
import type { Permission, RoleKey } from './permissions'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The shape of the `app` claim, and the pure predicates over it.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ SPLIT OUT OF claims.ts, AND NOT FOR TIDINESS.                             │
 * │                                                                           │
 * │ claims.ts imports the Supabase server client, which imports src/lib/env,  │
 * │ which THROWS at module load when NEXT_PUBLIC_SUPABASE_URL is absent. So   │
 * │ anything importing `can()` — a function that takes an object and returns  │
 * │ a boolean — transitively required a configured Supabase project.          │
 * │                                                                           │
 * │ That made the authorisation rules untestable without environment          │
 * │ variables, which is exactly backwards: they are the part of the system    │
 * │ most worth testing and the part that needs the least to run.              │
 * │                                                                           │
 * │ Nothing in this file may import a client, a database, or `server-only`.   │
 * │ It is pure, and it is imported by both server and client code.            │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * claims.ts re-exports everything here, so existing imports keep working.
 * ═══════════════════════════════════════════════════════════════════════════
 */

// dbId(), not z.string().uuid(): these arrive from uuid columns, and Zod 4's
// strict uuid() rejects the seeded org ids outright. See src/lib/db/id.ts —
// that mismatch is what made every signed-in user look unapproved.
export const appClaimsSchema = z.object({
  approved: z.boolean().default(false),
  /*
   * Added by migration 0070, and DEFAULTED FALSE ON PURPOSE.
   *
   * Tokens minted before 0070 carry no `email_verified`, and they stay valid
   * for the rest of their hour. Defaulting true would let those tokens walk
   * past the gate; defaulting false costs their holders one trip through
   * /verify-email, where a verified address is recognised immediately and the
   * session is refreshed. Fail closed, and let the cheap path correct it.
   */
  email_verified: z.boolean().default(false),
  company_id: dbId().nullable().default(null),
  brand_id: dbId().nullable().default(null),
  outlet_id: dbId().nullable().default(null),
  department_id: dbId().nullable().default(null),
  roles: z.array(z.string()).default([]),
  perms: z.array(z.string()).default([]),
})

/**
 * `userId` comes from the standard `sub` claim, not from the `app` object the
 * hook injects. Carried here so callers that need to record "who did this"
 * (approved_by, created_by, generated_by) do not need a second round trip to
 * getUser() on every mutation.
 */
export type AppClaims = z.infer<typeof appClaimsSchema> & { userId: string | null }

/** Fails closed. Every field absent, approved false, no roles, no permissions. */
export const DENY_ALL: AppClaims = {
  userId: null,
  approved: false,
  email_verified: false,
  company_id: null,
  brand_id: null,
  outlet_id: null,
  department_id: null,
  roles: [],
  perms: [],
}

export function hasRole(claims: AppClaims, role: RoleKey): boolean {
  return claims.roles.includes(role)
}

export function isSuperAdmin(claims: AppClaims): boolean {
  return hasRole(claims, 'super_admin')
}

/**
 * Mirrors public.has_perm() in migration 0004 exactly — including the approval
 * gate and the super-admin short-circuit.
 *
 * These two implementations MUST stay in step. If they diverge, the UI shows
 * actions the database then refuses, or worse, hides actions the database
 * would allow. Change one, change the other.
 *
 * NOTE the super-admin short-circuit is deliberate here and is OVERRIDDEN for
 * the question bank by src/lib/auth/bank-access.ts. That module exists because
 * this one cannot express a denial — see the box at the top of it.
 */
export function can(claims: AppClaims, permission: Permission): boolean {
  if (!claims.approved) return false
  if (isSuperAdmin(claims)) return true
  return claims.perms.includes(permission)
}
