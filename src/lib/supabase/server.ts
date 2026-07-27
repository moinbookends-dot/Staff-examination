import 'server-only'
import { cookies } from 'next/headers'
import { createServerClient } from '@supabase/ssr'
import { env } from '@/lib/env'
import type { Database } from '@/lib/db/database.types'

/**
 * Server client. Publishable key + the user's session from cookies, RLS enforced.
 *
 * Use in Server Components, Server Actions and Route Handlers.
 *
 * The try/catch around setAll is required, not defensive padding: Server
 * Components cannot mutate cookies, so a token refresh triggered during render
 * throws. Middleware refreshes the session on every request, so swallowing it
 * here is safe — the refreshed cookie is written there instead.
 */
export async function createClient() {
  const cookieStore = await cookies()

  return createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => {
              cookieStore.set(name, value, options)
            })
          } catch {
            // Called from a Server Component — middleware handles the refresh.
          }
        },
      },
    },
  )
}

/**
 * The authenticated user, or null.
 *
 * Always `getUser()`, never `getSession()`. getSession reads the cookie without
 * verifying it against the auth server, so a forged cookie passes. getUser
 * revalidates. The difference is a trivially bypassable auth check versus a
 * real one.
 */
export async function getUser() {
  const supabase = await createClient()
  const { data, error } = await supabase.auth.getUser()
  if (error) return null
  return data.user
}
