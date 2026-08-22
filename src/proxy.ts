import createIntlMiddleware from 'next-intl/middleware'
import { NextResponse, type NextRequest } from 'next/server'
import { routing } from '@/lib/i18n/routing'
import { updateSession } from '@/lib/supabase/middleware'

/**
 * Proxy: locale resolution → session refresh → route protection.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THIS FILE MUST LIVE AT src/proxy.ts, AND THE EXPORT MUST BE `proxy`.      │
 * │                                                                           │
 * │ It sat at the repository root as middleware.ts from M0 and NEVER RAN.     │
 * │ Next resolves this convention beside `app` — so in a src/ project it is   │
 * │ src/, not the root — and Next 16 renamed middleware to proxy (the codemod │
 * │ is `npx @next/codemod middleware-to-proxy`). Neither mistake produces a   │
 * │ warning; `next build` even prints "ƒ Proxy (Middleware)" because the file │
 * │ is compiled. It is simply never invoked.                                  │
 * │                                                                           │
 * │ The tell is that `/` returns 404 instead of redirecting to `/en`.         │
 * │ Everything else still worked, which is why it went unnoticed for two      │
 * │ milestones: the (app) layout re-checks approval and each action calls     │
 * │ requirePermission(), so unauthenticated users were bounced to /pending by │
 * │ the layout rather than to /login by this file. Wrong destination, right   │
 * │ outcome — which is exactly the argument for the layered design below.     │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ORDER MATTERS AND THE COMPOSITION IS FRAGILE. next-intl runs first and may
 * return a redirect (adding a locale prefix). updateSession then writes
 * refreshed auth cookies onto THAT SAME response object. Building a separate
 * response in either step drops the other's work — see the box in
 * src/lib/supabase/middleware.ts.
 *
 * WHAT THIS IS AND IS NOT. This is a routing convenience, not the security
 * boundary. A proxy can be bypassed by calling API routes directly, so every
 * server action and route handler re-checks authorisation via
 * requirePermission(), and RLS re-checks it again at the database. Three
 * layers, and only the innermost is authoritative — proven by the two
 * milestones this file spent switched off with nothing leaking.
 */

const intlMiddleware = createIntlMiddleware(routing)

/** Reachable without a session. Locale prefix is stripped before matching. */
const PUBLIC_PATHS = [
  '/login',
  '/register',
  '/forgot-password',
  '/reset-password',
  // No session exists at this point: mailer_autoconfirm is false, so signUp()
  // sends a mail and returns nothing to sign in with. The screen has to be
  // reachable by somebody holding an account and no token.
  '/verify-email',
  '/auth/callback',
  '/auth/confirm',
]

/**
 * Public paths a SIGNED-IN user may still sit on.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ WITHOUT /verify-email IN HERE, THE VERIFICATION GATE IS A REDIRECT LOOP.  ║
 * ║                                                                           ║
 * ║ Rule 4 below bounces a signed-in visitor off any public path to           ║
 * ║ /dashboard, which is right for /login and /register — you are already in. ║
 * ║ Applied to /verify-email it is catastrophic:                              ║
 * ║                                                                           ║
 * ║   /verify-email → (rule 4) → /dashboard → (rule 5, unverified)            ║
 * ║                → /verify-email → …                                        ║
 * ║                                                                           ║
 * ║ The browser gives up with ERR_TOO_MANY_REDIRECTS and the user cannot      ║
 * ║ reach the one screen that would let them fix it. Caught by check-auth's   ║
 * ║ "…and /verify-email is reachable", which is exactly why that assertion is ║
 * ║ paired with the redirect one rather than trusting the redirect alone.     ║
 * ║                                                                           ║
 * ║ /auth/callback and /auth/confirm are here for the same reason they always ║
 * ║ were: they are endpoints that DO something and then redirect, so bouncing ║
 * ║ them would skip the work.                                                 ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */
const SIGNED_IN_MAY_VISIT = ['/verify-email', '/auth/callback', '/auth/confirm']

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

export async function proxy(request: NextRequest) {
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

  // 4 — Signed in, sitting on an auth page. Send them onward — unless it is a
  // page a signed-in user legitimately needs. See SIGNED_IN_MAY_VISIT.
  if (user && isPublic && !SIGNED_IN_MAY_VISIT.includes(path)) {
    const url = request.nextUrl.clone()
    url.pathname = `/${locale}/dashboard`
    url.search = ''
    return NextResponse.redirect(url)
  }

  // 5 — The verification and approval gates, in that order.
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
    const claim = appClaimFromToken(request)

    /*
     * ┌───────────────────────────────────────────────────────────────────────┐
     * │ VERIFICATION IS CHECKED BEFORE APPROVAL, AND THE ORDER IS THE FLOW.   │
     * │                                                                       │
     * │ signup → confirm the address → wait for a manager → the app. Sending  │
     * │ an unverified user to /pending would tell them to wait for an         │
     * │ approval that nobody is going to grant, with no hint that the thing   │
     * │ actually blocking them is an email they have not opened.              │
     * │                                                                       │
     * │ email_verified arrived in migration 0070, so a token minted before it │
     * │ has no such key. appClaimFromToken returns undefined for that, and    │
     * │ the check below treats only an explicit `false` as unverified: an     │
     * │ hour-old token from before the migration keeps working until it       │
     * │ refreshes, instead of bouncing every signed-in user to a screen they  │
     * │ do not need. The database is unaffected either way — this is a        │
     * │ routing hint, and RLS is the authority.                               │
     * └───────────────────────────────────────────────────────────────────────┘
     */
    if (claim?.email_verified === false) {
      const url = request.nextUrl.clone()
      url.pathname = `/${locale}/verify-email`
      url.search = ''
      return NextResponse.redirect(url)
    }

    if (claim?.approved !== true) {
      const url = request.nextUrl.clone()
      url.pathname = `/${locale}/pending`
      url.search = ''
      return NextResponse.redirect(url)
    }
  }

  return response
}

/**
 * Reads the whole `app` claim off the access token cookie.
 *
 * Decoded WITHOUT signature verification — deliberately. This is a routing
 * hint only: the worst case is showing someone a page whose data RLS then
 * refuses to return. Verifying here would mean a JWKS fetch on every request
 * for no security gain, because the real checks are requirePermission() in
 * every action and has_perm() in every policy.
 *
 * Never make an authorisation decision from this value anywhere else.
 *
 * Returns undefined — not a defaulted object — when there is no readable
 * claim, so the caller can tell "the token says false" apart from "the token
 * predates this field". Those want opposite handling, and collapsing them is
 * what would bounce every existing session to a screen it does not need.
 */
function appClaimFromToken(
  request: NextRequest,
): { approved?: boolean; email_verified?: boolean } | undefined {
  const projectRef = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split('.')[0]
  const cookieName = `sb-${projectRef}-auth-token`

  // Large tokens are split across .0, .1, … chunks by @supabase/ssr. Sorted
  // NUMERICALLY, not lexicographically: with ten or more chunks ".10" sorts
  // before ".2" as text, and the reassembled JSON is silently scrambled.
  const chunks = request.cookies
    .getAll()
    .filter((c) => c.name === cookieName || c.name.startsWith(`${cookieName}.`))
    .sort((a, b) => chunkIndex(a.name, cookieName) - chunkIndex(b.name, cookieName))
    .map((c) => c.value)
    .join('')

  if (!chunks) return undefined

  try {
    const raw = chunks.startsWith('base64-')
      ? decodeBase64Url(chunks.slice('base64-'.length))
      : chunks

    const session = JSON.parse(raw)
    const accessToken: string | undefined = session?.access_token ?? session?.[0]
    if (!accessToken) return undefined

    const payload = JSON.parse(decodeBase64Url(accessToken.split('.')[1]))
    const app = payload?.app
    return app && typeof app === 'object' ? app : undefined
  } catch {
    // Unparseable cookie: no claim. The caller sends that to /pending, which
    // self-corrects on the next refresh — one redirect, and never a false
    // "unverified", which would send somebody to a screen with no way out.
    return undefined
  }
}

function chunkIndex(name: string, base: string): number {
  if (name === base) return -1
  return Number(name.slice(base.length + 1)) || 0
}

/**
 * base64URL → string. BOTH call sites above need this, and getting it wrong is
 * invisible until it is catastrophic.
 *
 * @supabase/ssr writes the session cookie with cookieEncoding 'base64url' by
 * DEFAULT, and JWT segments are base64url by specification. Plain atob() throws
 * on the '-' and '_' that base64url uses in place of '+' and '/'. Since this
 * function fails closed, that throw reads as "not approved" — so every signed-in
 * user is redirected to /pending, forever, and the only clue is that the app
 * works fine for nobody.
 *
 * The UTF-8 step matters here too, and not academically: atob yields a latin1
 * string, so a session carrying a Devanagari or Gujarati display name decodes
 * to mojibake. JSON.parse survives it, which is exactly why it would go
 * unnoticed until something read a name.
 */
function decodeBase64Url(value: string): string {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/')
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=')
  const binary = atob(padded)

  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return new TextDecoder().decode(bytes)
}

export const config = {
  matcher: [
    // Everything except Next internals, static assets, and API routes.
    // API routes are deliberately excluded: they do their own authorisation
    // via requirePermission() and must not be locale-redirected.
    '/((?!api|_next|_vercel|.*\\..*).*)',
  ],
}
