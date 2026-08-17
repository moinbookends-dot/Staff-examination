/**
 * ═════════════════════════════════════════════════════════════════════════════
 * DID THE APP ALLOW THIS REQUEST, OR REFUSE IT?
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE HTTP STATUS STOPPED ANSWERING THAT QUESTION WHEN STREAMING ARRIVED.   ║
 * ║                                                                           ║
 * ║ Adding src/app/[locale]/(app)/loading.tsx turned every authenticated      ║
 * ║ route into a STREAMED response. Next now flushes the loading shell — with ║
 * ║ status 200 — before the page component runs, so a requirePermission()     ║
 * ║ that throws a moment later cannot change a status that is already on the  ║
 * ║ wire. Refused pages answer 200. notFound() pages answer 200.              ║
 * ║                                                                           ║
 * ║ NOTHING LEAKED, and that was verified rather than assumed: an employee    ║
 * ║ fetching /questions, /papers/generate, /exams/live and /settings receives ║
 * ║ no question text, no external id and no question uuid — only the shell    ║
 * ║ and the error boundary. The authorisation still works; the STATUS CODE    ║
 * ║ stopped being evidence of it.                                            ║
 * ║                                                                           ║
 * ║ That distinction matters enormously for these scripts. Every DENY row in  ║
 * ║ every permission matrix was asserted as "status !== 200". Left alone,     ║
 * ║ they would all have flipped to reporting ALLOW — a permission suite that  ║
 * ║ says the bank is wide open when it is not is as useless as one that says  ║
 * ║ it is closed when it is not.                                             ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * So the verdict is read from the BODY, which is where the answer now lives:
 *
 *   · REFUSAL_DIGEST ('FORBIDDEN', set in src/lib/auth/guards.ts) is serialised
 *     into the streamed payload by Next whenever an AuthorizationError escapes.
 *     Chosen originally because `error.name` does not survive a production
 *     build; it turns out to be the only refusal signal that survives streaming
 *     either.
 *   · The error boundary itself is a CLIENT component, so its markup is NOT in
 *     the streamed HTML. Do not look for it here.
 *
 * This is strictly a better test than the status ever was: it asserts the
 * refusal the application actually performed, rather than a number that
 * happened to correlate with it.
 */

/** Present in the streamed payload of any page that threw AuthorizationError. */
const REFUSAL_MARKER = 'FORBIDDEN'

/** Present when a page called notFound(). */
const NOT_FOUND_MARKERS = ['NEXT_HTTP_ERROR_FALLBACK;404', 'NEXT_NOT_FOUND']

/**
 * @param status HTTP status
 * @param body   the full response text — required, because the status alone
 *               can no longer distinguish allow from refuse
 */
export function verdictOf(status, body = '') {
  if (status === 307 || status === 302) return 'REDIRECT'
  if (status === 401) return 'DENY(401)'
  if (status === 403) return 'DENY(403)'

  // A streamed 200 that carries the refusal digest is a refusal, whatever the
  // status line says.
  if (body.includes(REFUSAL_MARKER)) return 'DENY(streamed)'
  if (NOT_FOUND_MARKERS.some((m) => body.includes(m))) return 'NOTFOUND'

  if (status === 404) return 'NOTFOUND'
  if (status === 500) return 'DENY(500)'
  if (status === 200) return 'ALLOW'
  return `OTHER(${status})`
}

/** True when the app refused, by any of the routes it can express a refusal. */
export const wasRefused = (status, body = '') => {
  const v = verdictOf(status, body)
  return v.startsWith('DENY') || v === 'REDIRECT' || v === 'NOTFOUND'
}

/** True only when the caller genuinely reached the page. */
export const wasAllowed = (status, body = '') => verdictOf(status, body) === 'ALLOW'
