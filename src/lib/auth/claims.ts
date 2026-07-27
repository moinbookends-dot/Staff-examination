import 'server-only'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import type { Permission, RoleKey } from './permissions'

/**
 * Reading the `app` claim injected by the custom access token hook (migration 0004).
 *
 * WHY getClaims() AND NOT getSession():
 * getSession() reads the token out of the cookie and hands it over without
 * verifying the signature — a forged cookie sails straight through. getClaims()
 * verifies against the project's signing keys. Since these claims decide
 * authorisation, verification is the entire point.
 */

const appClaimsSchema = z.object({
  approved: z.boolean().default(false),
  company_id: z.string().uuid().nullable().default(null),
  brand_id: z.string().uuid().nullable().default(null),
  outlet_id: z.string().uuid().nullable().default(null),
  department_id: z.string().uuid().nullable().default(null),
  roles: z.array(z.string()).default([]),
  perms: z.array(z.string()).default([]),
})

/**
 * `userId` comes from the standard `sub` claim, not from the `app` object the
 * hook injects. Carried here so callers that need to record "who did this"
 * (approved_by, evaluator_id, created_by) do not need a second round trip to
 * getUser() on every mutation.
 */
export type AppClaims = z.infer<typeof appClaimsSchema> & { userId: string | null }

/** Fails closed. Every field absent, approved false, no roles, no permissions. */
const DENY_ALL: AppClaims = {
  userId: null,
  approved: false,
  company_id: null,
  brand_id: null,
  outlet_id: null,
  department_id: null,
  roles: [],
  perms: [],
}

/**
 * Verified app claims for the current request, or DENY_ALL.
 *
 * Returns DENY_ALL rather than throwing so callers can branch on `approved`
 * without try/catch at every site. Anything that must hard-fail should use
 * requirePermission() in ./guards.
 */
export async function getAppClaims(): Promise<AppClaims> {
  const supabase = await createClient()
  const { data, error } = await supabase.auth.getClaims()

  if (error || !data?.claims) return DENY_ALL

  const raw = data.claims as Record<string, unknown>
  const userId = typeof raw.sub === 'string' ? raw.sub : null

  const parsed = appClaimsSchema.safeParse(raw.app ?? {})

  // An unparseable or absent `app` claim means the hook is misconfigured, or
  // the token predates a schema change. Denying is the only safe reading — a
  // malformed claim must never be treated as permissive.
  //
  // NOTE: a missing `app` claim is also exactly what you see when the custom
  // access token hook is not enabled on the project. Symptom: every screen
  // empty, no errors anywhere. Run scripts/verify-auth-hook.mjs.
  return parsed.success ? { ...parsed.data, userId } : { ...DENY_ALL, userId }
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
 */
export function can(claims: AppClaims, permission: Permission): boolean {
  if (!claims.approved) return false
  if (isSuperAdmin(claims)) return true
  return claims.perms.includes(permission)
}
