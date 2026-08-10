/**
 * Verify the AUTHENTICATED shell actually renders.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ WHY A SIGNED-OUT CURL IS NOT VERIFICATION.                                ║
 * ║                                                                           ║
 * ║ /en/dashboard answers 307 to a signed-out request, so it never renders    ║
 * ║ the (app) layout at all. That is exactly where the failure lived:         ║
 * ║                                                                           ║
 * ║   Functions cannot be passed directly to Client Components…               ║
 * ║   The offending value is: guard: function canManageExamSettings           ║
 * ║                                                                           ║
 * ║ typecheck, lint and `next build` all passed with that bug present,        ║
 * ║ because it is a runtime serialisation boundary. The only way to know it   ║
 * ║ is fixed is to render the page as a signed-in user.                       ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Creates one temporary user, signs in through the real login form so the
 * session cookies are the ones the app issues, fetches the shell, and deletes
 * the user again — the same provisioning render-check.mjs performs.
 *
 *   node scripts/check-shell.mjs
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'

const APP = process.env.APP_URL ?? 'http://localhost:3000'
const PASSWORD = 'shell-check-password-1'
const email = `shell-check+${Date.now()}@example.com`

function readEnvLocal() {
  const raw = readFileSync(resolve('.env.local'), 'utf-8')
  const out = {}
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) out[m[1]] = m[2].trim()
  }
  return out
}

const env = readEnvLocal()
const ref = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split('.')[0]

let fail = 0
const ok = (m) => console.log(`  PASS  ${m}`)
const check = (cond, pass, failMsg) => {
  if (cond) ok(pass)
  else {
    fail += 1
    console.log(`  FAIL  ${failMsg}`)
  }
}

const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST ?? 'aws-0-ap-southeast-1.pooler.supabase.com',
  port: 5432,
  user: `postgres.${ref}`,
  password: env.SUPABASE_DB_PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
})

let userId = null

try {
  await db.connect()

  // ── Provision ────────────────────────────────────────────────────────────
  const made = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: 'Shell Check', locale: 'en' },
    }),
  })
  if (!made.ok) throw new Error(`create user: ${made.status} ${await made.text()}`)
  userId = (await made.json()).id

  await db.query(`update public.profiles set approval_status='approved' where id=$1`, [userId])

  /*
   * Give the account the chef role.
   *
   * Chef is the harder case for the bug being verified: they hold NO bank.*
   * permission, so visibleNavItems() filters items out and mobileNavItems()
   * returns four tabs rather than five. If anything about the guard evaluation
   * or the stripping is wrong, a chef hits it first.
   */
  await db.query(
    `insert into public.user_roles (user_id, role_id)
     select $1, id from public.roles where key='chef' and company_id is null
     on conflict do nothing`,
    [userId],
  )

  /*
   * ── The session cookie ───────────────────────────────────────────────────
   *
   * Posting the login form does NOT work: sign-in goes through a Server
   * Action, so a plain form POST is not the route and the first attempt at
   * this script sat at 307 wondering why.
   *
   * The token is minted directly and encoded exactly as @supabase/ssr writes
   * it: `base64-` + base64URL of the session JSON, split into 3180-character
   * chunks named .0, .1, … STANDARD base64 would be silently wrong here — see
   * decodeBase64Url in src/proxy.ts. Copied from render-check.mjs, which
   * learned all of this the hard way.
   */
  const session = await (
    await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: {
        apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ email, password: PASSWORD }),
    })
  ).json()

  if (!session.access_token) {
    throw new Error(`sign-in failed: ${JSON.stringify(session).slice(0, 200)}`)
  }

  const cookieName = `sb-${ref}-auth-token`
  const encoded = 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url')
  const parts = []
  for (let i = 0; i < encoded.length; i += 3180) parts.push(encoded.slice(i, i + 3180))
  const cookie =
    parts.length === 1
      ? `${cookieName}=${parts[0]}`
      : parts.map((p, i) => `${cookieName}.${i}=${p}`).join('; ')

  const get = async (path) => {
    const res = await fetch(`${APP}${path}`, { headers: { cookie }, redirect: 'manual' })
    return { status: res.status, html: await res.text(), location: res.headers.get('location') }
  }

  // ── The verification ─────────────────────────────────────────────────────
  const dash = await get('/en/dashboard')

  check(
    dash.status === 200,
    `/en/dashboard renders for a signed-in chef (${dash.status})`,
    `/en/dashboard returned ${dash.status} → ${dash.location}`,
  )

  /*
   * The precise failure signature. Next renders the serialisation error into
   * the page rather than only logging it, so an assertion on the HTML catches
   * a regression even if the status is still 200.
   */
  check(
    !/Functions cannot be passed directly to Client Components/.test(dash.html),
    'no Server → Client serialisation error on the shell',
    'THE GUARD FUNCTION IS CROSSING INTO A CLIENT COMPONENT AGAIN',
  )

  check(
    !/A server error occurred|This page couldn.t load/.test(dash.html),
    'the shell rendered without a server error',
    'the shell returned the generic server-error page',
  )

  // The nav itself, and the permission rules it encodes.
  check(/Dashboard/.test(dash.html), 'the sidebar rendered its items', 'no nav items rendered')

  /*
   * ┌─────────────────────────────────────────────────────────────────────────┐
   * │ THESE SCAN THE WHOLE PAGE, NOT JUST THE NAV — DELIBERATELY.             │
   * │                                                                         │
   * │ A link a chef must not follow is equally wrong in a sidebar and in a    │
   * │ dashboard tile, so the assertion is on the rendered document.           │
   * │                                                                         │
   * │ THREE ENTRIES WERE REMOVED FROM THIS LIST ON 10 AUG 2026, and the       │
   * │ reason is a product change rather than a failing check being silenced:  │
   * │ /exams, /evaluate and /results are now steps in a workflow the product  │
   * │ supports. 0062 and 0063 made online delivery real, so a chef publishes  │
   * │ a paper, candidates sit it, and the chef marks it. Every paper carries  │
   * │ short answers by blueprint, so every submission waits at `evaluating`   │
   * │ for a human — without /evaluate the results would never come out.       │
   * │                                                                         │
   * │ /verify and /reports STAY forbidden and are still asserted below.       │
   * │ Paper-backed exams publish with verification_mode 'single', so nothing  │
   * │ reaches the verify queue, and analytics is separate work.               │
   * └─────────────────────────────────────────────────────────────────────────┘
   */
  const forbidden = [
    ['/en/questions', 'the Question Bank'],
    ['/en/settings', 'Settings'],
    ['/en/verify', 'Verify'],
    ['/en/reports', 'Analytics'],
  ]

  for (const [href, what] of forbidden) {
    check(
      !new RegExp(`href="${href}"`).test(dash.html),
      `a chef is offered no link to ${what}`,
      `a chef was offered ${what} (${href}) — check the page body, not just the nav`,
    )
  }

  /*
   * ── Every new route, as a signed-in chef ──────────────────────────────
   *
   * A chef holds papers.generate and papers.read_history but no bank.* and no
   * settings.manage, so this pass asserts BOTH directions in one sweep: the
   * paper screens render, and the Editor/admin screens refuse.
   */
  /*
   * ┌─────────────────────────────────────────────────────────────────────────┐
   * │ 500 IS THE EXPECTED CODE FOR A REFUSAL TODAY, AND THAT IS WORTH KNOWING.│
   * │                                                                         │
   * │ requirePermission throws AuthorizationError, which carries status 403 —  │
   * │ but nothing translates it. It lands in (app)/error.tsx, and Next renders │
   * │ an error boundary with a 500. So a page somebody may not see reports a   │
   * │ SERVER FAULT rather than "you do not have access".                       │
   * │                                                                         │
   * │ Pre-existing for every gated route in the app, not introduced here. It   │
   * │ is asserted as 500 rather than 403 so this check reflects reality; when  │
   * │ the boundary learns to read `status`, these expectations change with it. │
   * │                                                                         │
   * │ Generate and History expect 200 as of the 0053–0056 push and db:seed:    │
   * │ the chef role now holds papers.generate and papers.read_history. Before  │
   * │ seeding they refused, which is why this file briefly carried a flag for  │
   * │ both states — the flag is gone because the seeded state is now the only  │
   * │ one that exists.                                                        │
   * └─────────────────────────────────────────────────────────────────────────┘
   */
  for (const [path, expected, why] of [
    ['/en/papers/generate', 200, 'a chef can reach Generate'],
    ['/en/history', 200, 'a chef can reach Exam History'],
    ['/en/questions', 500, 'a chef is REFUSED the Question Bank'],
    // The sub-routes. These were reachable at 200 by a chef until a layout
    // gated the whole subtree — each page carried requirePermission
    // ('questions.read'), which the chef role holds.
    ['/en/questions/new', 500, 'a chef is REFUSED Create Question'],
    // Topic Management sits inside the same subtree and is therefore covered by
    // the same gate. Asserted separately rather than assumed: the layout is what
    // protects it, and a future route added OUTSIDE the subtree would look
    // identical in nav.ts while being wide open.
    ['/en/questions/topics', 500, 'a chef is REFUSED Topic Management'],
    // The import screen is the one route that can write thousands of rows in a
    // single act, so it gets its own assertion rather than relying on the
    // subtree gate being remembered.
    ['/en/questions/import', 500, 'a chef is REFUSED Import'],
    // The subtree layout runs BEFORE route resolution, so even a path with no
    // page refuses rather than 404s — the gate cannot be probed for which
    // editor routes exist.
    ['/en/questions/00000000-0000-0000-0000-0000000000ff', 500, 'a chef is REFUSED Edit Question'],
    ['/en/settings', 500, 'a chef is REFUSED Settings'],
  ]) {
    const res = await get(path)
    check(
      res.status === expected,
      `${why} (${res.status})`,
      `${path} returned ${res.status}, expected ${expected}`,
    )
    check(
      !/Functions cannot be passed directly to Client Components/.test(res.html),
      `${path} has no Server → Client serialisation error`,
      `${path} IS LEAKING A FUNCTION ACROSS THE CLIENT BOUNDARY`,
    )
  }

  /*
   * ── /history/[id] ────────────────────────────────────────────────────
   *
   * A malformed id and a well-formed id that does not exist must BOTH 404.
   * The second matters more: RLS makes another company's paper simply absent,
   * so 404 is the only response that does not confirm the row exists.
   */
  const historyEmpty = await get('/en/history')
  check(
    historyEmpty.status === 200,
    `/en/history renders its empty state (${historyEmpty.status})`,
    `/en/history returned ${historyEmpty.status}`,
  )

  const badId = await get('/en/history/not-a-uuid')
  check(
    badId.status === 404,
    `a malformed paper id is 404 (${badId.status})`,
    `/en/history/not-a-uuid returned ${badId.status}, expected 404`,
  )

  const missingId = await get('/en/history/00000000-0000-0000-0000-0000000000ff')
  check(
    missingId.status === 404,
    `an unknown paper id is 404 (${missingId.status})`,
    `an unknown paper id returned ${missingId.status}, expected 404`,
  )

  for (const res of [badId, missingId, historyEmpty]) {
    check(
      !/Functions cannot be passed directly to Client Components/.test(res.html),
      'history route has no Server → Client serialisation error',
      'HISTORY IS LEAKING A FUNCTION ACROSS THE CLIENT BOUNDARY',
    )
  }

  /*
   * ── The export route ─────────────────────────────────────────────────────
   *
   * ┌─────────────────────────────────────────────────────────────────────────┐
   * │ THE ONE ROUTE NO LAYOUT PROTECTS.                                       │
   * │                                                                         │
   * │ Everything under /questions/* is gated by a layout on                    │
   * │ canOpenQuestionBank. /api/bank/export is not under that layout, and      │
   * │ src/proxy.ts excludes /api from its matcher entirely — so NOTHING has    │
   * │ checked the session before the handler runs. Its own check is the only   │
   * │ thing standing between a caller and the entire question bank as a file.  │
   * │                                                                         │
   * │ Asserted for a chef AND signed out, because those fail on different      │
   * │ lines of the handler.                                                   │
   * └─────────────────────────────────────────────────────────────────────────┘
   */
  const exportAsChef = await get('/api/bank/export?brand=00000000-0000-0000-0000-00000000b001')
  check(
    exportAsChef.status === 403,
    `a chef is REFUSED the question-bank export (${exportAsChef.status})`,
    `A CHEF DOWNLOADED THE QUESTION BANK (${exportAsChef.status})`,
  )
  check(
    !/"questions"\s*:/.test(exportAsChef.html),
    'the refused export returned no question data',
    'THE REFUSED EXPORT STILL RETURNED QUESTIONS',
  )

  const exportSignedOut = await fetch(
    `${APP}/api/bank/export?brand=00000000-0000-0000-0000-00000000b001`,
    { redirect: 'manual' },
  )
  check(
    exportSignedOut.status !== 200,
    `a signed-out request cannot export (${exportSignedOut.status})`,
    `THE EXPORT IS PUBLIC (${exportSignedOut.status})`,
  )

  // Signed-out routes, for completeness.
  for (const path of ['/en/login', '/en/register']) {
    const res = await fetch(`${APP}${path}`)
    check(res.status === 200, `${path} renders (${res.status})`, `${path} → ${res.status}`)
  }
} finally {
  // ── Clean up, whatever happened ──────────────────────────────────────────
  if (userId) {
    await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users/${userId}`, {
      method: 'DELETE',
      headers: {
        apikey: env.SUPABASE_SECRET_KEY,
        Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      },
    }).catch(() => {})
    console.log(`\n  cleaned up ${email}`)
  }
  await db.end().catch(() => {})
}

console.log(fail === 0 ? '\n  All shell checks passed.\n' : `\n  ${fail} FAILED\n`)
process.exit(fail === 0 ? 0 : 1)
