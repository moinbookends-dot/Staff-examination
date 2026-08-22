import { createServerClient } from '@supabase/ssr'
import type { NextRequest, NextResponse } from 'next/server'
import { env } from '@/lib/env'

/**
 * Refreshes the Supabase session and returns the authenticated user.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE CRITICAL DETAIL: this function DECORATES a response you pass in; it   │
 * │ does not create its own.                                                  │
 * │                                                                           │
 * │ next-intl's middleware may already have produced a redirect or rewrite    │
 * │ (adding a locale prefix, for instance). If this function built a fresh    │
 * │ NextResponse.next() and wrote refreshed auth cookies onto that, those     │
 * │ cookies would be discarded the moment next-intl's redirect was returned   │
 * │ instead — producing an infinite login loop that is genuinely miserable    │
 * │ to debug, because every individual piece looks correct.                   │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export async function updateSession(request: NextRequest, response: NextResponse) {
  const supabase = createServerClient(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => {
            // Both: the request so downstream reads in this same pass see the
            // refreshed token, and the response so the browser stores it.
            request.cookies.set(name, value)
            response.cookies.set(name, value, options)
          })
        },
      },
    },
  )

  // getUser(), never getSession(). getSession trusts the cookie without
  // verifying it against the auth server, so a forged cookie passes. This call
  // is also what triggers the token refresh that keeps the session alive.
  const { data, error } = await supabase.auth.getUser()

  return { response, user: error ? null : data.user }
}
