import 'server-only'
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import { env, getSecretKey } from '@/lib/env'
import type { Database } from '@/lib/db/database.types'

/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  DANGER — THIS CLIENT BYPASSES ROW-LEVEL SECURITY ENTIRELY.               ║
 * ║                                                                           ║
 * ║  It can read and write every row of every table as any user. RLS policies ║
 * ║  do not apply. There is no safety net behind this.                        ║
 * ║                                                                           ║
 * ║  RULE: every function that calls createAdminClient() MUST begin with an   ║
 * ║  explicit `await requirePermission('...')` check against the caller's     ║
 * ║  own session. No exceptions.                                              ║
 * ║                                                                           ║
 * ║  Legitimate uses are narrow:                                              ║
 * ║    · serving sanitised exam papers (strips answer keys — plan §4.3)       ║
 * ║    · registration dropdowns before a session exists (plan §5.4)           ║
 * ║    · bulk import and audit writes                                         ║
 * ║    · scheduled jobs with no user context                                  ║
 * ║                                                                           ║
 * ║  If you are reaching for this because RLS is "getting in the way", the    ║
 * ║  policy is wrong. Fix the policy.                                         ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * An ESLint no-restricted-imports rule confines this module to API routes and
 * server actions. `import 'server-only'` is the second line of defence: it
 * turns any client-component import chain into a build error.
 */
export function createAdminClient() {
  return createSupabaseClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    getSecretKey(),
    {
      auth: {
        // No session persistence or refresh — this client has no user and must
        // never pick one up from ambient storage.
        autoRefreshToken: false,
        persistSession: false,
        detectSessionInUrl: false,
      },
    },
  )
}
