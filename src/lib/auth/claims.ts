import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { appClaimsSchema, DENY_ALL, type AppClaims } from './can'

/*
 * The schema and the pure predicates live in ./can, which imports no client
 * and no environment. They are re-exported here so every existing
 * `from '@/lib/auth/claims'` import keeps working — see the box in that file
 * for why the split was necessary rather than cosmetic.
 */
export { hasRole, isSuperAdmin, can, appClaimsSchema, DENY_ALL } from './can'
export type { AppClaims } from './can'

/**
 * Reading the `app` claim injected by the custom access token hook (migration 0004).
 *
 * WHY getClaims() AND NOT getSession():
 * getSession() reads the token out of the cookie and hands it over without
 * verifying the signature — a forged cookie sails straight through. getClaims()
 * verifies against the project's signing keys. Since these claims decide
 * authorisation, verification is the entire point.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ initialize() IS NOT OPTIONAL. See below, and do not "tidy" it away.       │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

/**
 * Verified app claims for the current request, or DENY_ALL.
 *
 * Returns DENY_ALL rather than throwing so callers can branch on `approved`
 * without try/catch at every site. Anything that must hard-fail should use
 * requirePermission() in ./guards.
 */
export async function getAppClaims(): Promise<AppClaims> {
  const supabase = await createClient()

  // ╔═════════════════════════════════════════════════════════════════════════╗
  // ║ THE SERVER CLIENT DOES NOT LOAD ITS SESSION ON ITS OWN.                 ║
  // ║                                                                         ║
  // ║ @supabase/ssr constructs createServerClient with skipAutoInitialize:    ║
  // ║ true, so nothing reads the cookie until initialize() is awaited. Skip   ║
  // ║ it and getClaims() calls getSession() internally, finds no session, and ║
  // ║ returns { data: null } WITH NO ERROR — which lands on DENY_ALL below.   ║
  // ║                                                                         ║
  // ║ The symptom is not a crash. Every signed-in user is treated as          ║
  // ║ unapproved: the (app) layout bounces them to /pending and every guard   ║
  // ║ throws AuthenticationError, while the token in their cookie is          ║
  // ║ perfectly valid. Nothing in the RLS suite or the HTTP walkthrough can   ║
  // ║ see it, because neither renders a page.                                 ║
  // ║                                                                         ║
  // ║ getUser() happens to initialise as a side effect, which is why the      ║
  // ║ proxy's updateSession() worked and this did not.                        ║
  // ╚═════════════════════════════════════════════════════════════════════════╝
  await supabase.auth.initialize()

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
