import { createBrowserClient } from '@supabase/ssr'
import { env } from '@/lib/env'
import type { Database } from '@/lib/db/database.types'

/**
 * Browser client. Publishable key, RLS enforced.
 *
 * Use in Client Components only. For Server Components, Server Actions and
 * Route Handlers use `@/lib/supabase/server`, which reads the session from
 * cookies — this one cannot.
 */
export function createClient() {
  return createBrowserClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  )
}
