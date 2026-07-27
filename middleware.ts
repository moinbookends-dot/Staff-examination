import createIntlMiddleware from 'next-intl/middleware'
import { NextResponse, type NextRequest } from 'next/server'
import { routing } from '@/lib/i18n/routing'
import { updateSession } from '@/lib/supabase/middleware'

/**
 * Middleware: locale resolution → session refresh → route protection.
 *
 * ORDER MATTERS AND THE COMPOSITION IS FRAGILE. next-intl runs first and may
 * return a redirect (adding a locale prefix). updateSession then writes
 * refreshed auth cookies onto THAT SAME response object. Building a separate
 * response in either step drops the other's work — see the box in
 * src/lib/supabase/middleware.ts.
 *
 * WHAT THIS IS AND IS NOT. This is a routing convenience, not the security
 * boundary. Middleware can be bypassed by calling API routes directly, so
 * every server action and route handler re-checks authorisation via
 * requirePermission(), and RLS re-checks it again at the database. Three
 * layers, and only the innermost is authoritative.
 */

const intlMiddleware = createIntlMiddleware(routing)

/** Reachable without a session. Locale prefix is stripped before matching. */
const PUBLIC_PATHS = [
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
  '/auth/callback',
  '/auth/confirm',
]

/** Reachable with a session but before approval. */
const PENDING_ALLOWED_PATHS = ['/pending', '/logout']

function stripLocale(pathname: string): string {
  const segments = pathname.split('/')
  if (segments.length > 1 && (routing.locales as readonly string[]).includes(segments[1])) {
    return '/' + segments.slice(2).join('/')
  }
  return pathname
}

function localeOf(pathname: string): string {
  const segments = pathname.split('/')
  if (segments.length > 1 && (routing.locales as readonly string[]).includes(segments[1])) {
    return segments[1]
  }
  return routing.defaultLocale
}

export async function middleware(request: NextRequest) {
  // 1 — Locale. May already be a redirect or rewrite.
  const response = intlMiddleware(request) ?? NextResponse.next()

  // If next-intl is redirecting to add a locale prefix, let it complete. Doing
  // auth work now would resolve against a path that is about to change.
  if (response.status === 307 || response.status === 308) {
    return response
  }

  // 2 — Refresh the session, writing cookies onto next-intl's response.
  const { user } = await updateSession(request, response)

  const path = stripLocale(request.nextUrl.pathname)
  const locale = localeOf(request.nextUrl.pathname)

  const isPublic = PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`))
  const isPendingAllowed = PENDING_ALLOWED_PATHS.some((p) => path === p)

  // 3 — Unauthenticated visitors to a protected route.
  if (!user && !isPublic) {
    const url = request.nextUrl.clone()
    url.pathname = `/${locale}/login`
    // Preserve the destination so login can return them to it.
    url.searchParams.set('next', request.nextUrl.pathname)
    return NextResponse.redirect(url)
  }

  // 4 — Signed in, sitting on an auth page. Send them onward.
  if (user && isPublic && path !== '/auth/callback' && path !== '/auth/confirm') {
    const url = request.nextUrl.clone()
    url.pathname = `/${locale}/dashboard`
    url.search = ''
    return NextResponse.redirect(url)
  }

  // 5 — The approval gate.
  //
  // Read from the ACCESS TOKEN CLAIM, not by querying profiles: a database read
  // in middleware runs on every single request, and the claim is already
  // present and signed.
  //
  // The trade-off is staleness — a user approved five minutes ago still carries
  // approved=false until their token refreshes (up to the JWT lifetime). The
  // /pending page handles that by polling me_status(), which reads profiles
  // directly, then calling refreshSession() to mint a token with the new claim.
  // See migration 0004 and plan §5.5.
  if (user && !isPublic && !isPendingAllowed) {
    const approved = isApprovedFromToken(request)
    if (!approved) {
      const url = request.nextUrl.clone()
      url.pathname = `/${locale}/pending`
      url.search = ''
      return NextResponse.redirect(url)
    }
  }

  return response
}

/**
 * Reads `app.approved` from the access token cookie.
 *
 * Decoded WITHOUT signature verification — deliberately. This is a routing
 * hint only: the worst case is showing someone a page whose data RLS then
 * refuses to return. Verifying here would mean a JWKS fetch on every request
 * for no security gain, because the real checks are requirePermission() in
 * every action and has_perm() in every policy.
 *
 * Never make an authorisation decision from this value anywhere else.
 */
function isApprovedFromToken(request: NextRequest): boolean {
  const projectRef = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split('.')[0]
  const cookieName = `sb-${projectRef}-auth-token`

  // Large tokens are split across .0, .1, … chunks by @supabase/ssr.
  const chunks = request.cookies
    .getAll()
    .filter((c) => c.name === cookieName || c.name.startsWith(`${cookieName}.`))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((c) => c.value)
    .join('')

  if (!chunks) return false

  try {
    const raw = chunks.startsWith('base64-')
      ? atob(chunks.slice('base64-'.length))
      : chunks

    const session = JSON.parse(raw)
    const accessToken: string | undefined = session?.access_token ?? session?.[0]
    if (!accessToken) return false

    const payload = JSON.parse(
      atob(accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')),
    )
    return payload?.app?.approved === true
  } catch {
    // Unparseable cookie: treat as unapproved. Failing closed is correct — the
    // cost is one redirect to /pending, which self-corrects on refresh.
    return false
  }
}

export const config = {
  matcher: [
    // Everything except Next internals, static assets, and API routes.
    // API routes are deliberately excluded: they do their own authorisation
    // via requirePermission() and must not be locale-redirected.
    '/((?!api|_next|_vercel|.*\\..*).*)',
  ],
}
