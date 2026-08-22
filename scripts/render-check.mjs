/**
 * Renders the authenticated pages against a running dev server, with a real
 * session cookie, and asserts on the HTML.
 *
 *   npm run dev            # in one terminal
 *   node scripts/render-check.mjs
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHY THIS EXISTS, ON TOP OF THE RLS SUITE AND walkthrough.mjs.             │
 * │                                                                           │
 * │ Neither of those renders a page. The RLS tests talk to Postgres directly  │
 * │ and fabricate the `app` claim; the walkthrough drives PostgREST over HTTP │
 * │ with real tokens. Both were green for two milestones while the browser    │
 * │ app was completely unusable:                                              │
 * │                                                                           │
 * │   · middleware.ts sat at the repository root, where Next never looks in a │
 * │     src/ project — and Next 16 renamed the convention to proxy.ts anyway. │
 * │   · getAppClaims() called getClaims() without initialize(), and           │
 * │     @supabase/ssr's server client sets skipAutoInitialize: true, so it    │
 * │     found no session and returned DENY_ALL.                               │
 * │   · the `app` claim was parsed with Zod 4's strict .uuid(), which rejects │
 * │     every fixed id in seed.sql.                                           │
 * │                                                                           │
 * │ Each produced the same symptom — a signed-in user bounced to /pending —   │
 * │ and no test could see it. This one can.                                   │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Creates one temporary chef and one question, and removes both at the end.
 *
 * ⚠ DO NOT RUN `next build` WHILE `next dev` IS RUNNING. They share .next, and
 * the build overwrites the dev server's route manifest — every dynamic route
 * then 404s while the list pages keep working, which looks exactly like a
 * routing bug in the app. If this script suddenly fails en masse, stop dev,
 * `rm -rf .next`, and start it again before believing any of it.
 */
import { Client } from 'pg'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = resolve(__dirname, '..')

function readEnvLocal() {
  const raw = readFileSync(resolve(root, '.env.local'), 'utf-8')
  const out = {}
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) out[m[1]] = m[2].trim()
  }
  return out
}

const env = readEnvLocal()
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL
const PUB = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
const SECRET = env.SUPABASE_SECRET_KEY
const ref = new (globalThis.URL)(URL_).hostname.split('.')[0]

const APP = process.env.APP_URL ?? 'http://localhost:3000'
const PASSWORD = 'render-check-password-1'
const stamp = Date.now()

let fail = 0
const ok = (m) => console.log(`  ✅ ${m}`)
const bad = (m) => { console.log(`  ❌ ${m}`); fail++ }
const check = (c, good, notGood) => { if (c) ok(good); else bad(notGood) }

const adminHeaders = { apikey: SECRET, Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }

/*
 * buttonIsDisabled() was removed with the exam authoring screens on 11 Aug
 * 2026 — every one of its callers asserted on the Publish / Duplicate / Save
 * buttons of /exams/[id], which no longer exists.
 *
 * ITS LESSON IS WORTH MORE THAN THE FUNCTION AND IS RECORDED HERE: it read the
 * `disabled` ATTRIBUTE by looking back from the text node, because every button
 * in this app carries Tailwind variant classes containing the word
 * (`disabled:pointer-events-none disabled:opacity-50`), so `.includes(
 * 'disabled')` reports every button as disabled and any assertion built on it
 * passes vacuously. The same trap applies to `.includes('Publish')`, which
 * matches the next-intl message bundle every page serialises for the client
 * provider — which is why the checks below match `>text<` rather than text.
 */

// Fail fast with a useful message rather than twenty confusing assertion errors.
try {
  await fetch(APP, { redirect: 'manual' })
} catch {
  console.error(`\nNo dev server at ${APP}. Run \`npm run dev\` first.\n`)
  process.exit(1)
}

const db = new Client({
  host: process.env.SUPABASE_DB_HOST ?? 'aws-0-ap-southeast-1.pooler.supabase.com',
  port: 5432,
  user: `postgres.${ref}`,
  password: env.SUPABASE_DB_PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
})
await db.connect()

const createdUsers = []
const createdQuestions = []
const createdExams = []

/**
 * This run's own category.
 *
 * The rule checks below deliberately ask for more questions than exist, to prove
 * the shortfall is reported and blocks publishing. They used to point at the
 * seeded Food Safety category and depend on it being empty — which made every
 * shortfall assertion a hostage to whatever else happened to be in the database.
 * Seeding twelve demo questions flipped seven checks at once, and a real
 * deployment with real Food Safety questions would have done the same.
 *
 * Owning the category makes the pool exactly what this script put in it.
 */
const RENDER_CAT = '00000000-0000-0000-0000-0000000cc001'

try {
  await db.query(
    `insert into public.categories (id, company_id, name, slug)
     values ($1,$2,'Render Check','render-check')
     on conflict (id) do nothing`,
    [RENDER_CAT, '00000000-0000-0000-0000-00000000c001'],
  )

  // ── 0. Locale routing ──────────────────────────────────────────────────────
  // The canary for "is the proxy running at all". Without it `/` has no route
  // and 404s, which is precisely how the dead middleware.ts went unnoticed.
  console.log('\n0. Routing')
  const rootRes = await fetch(`${APP}/`, { redirect: 'manual' })
  check(
    rootRes.status === 307 && (rootRes.headers.get('location') ?? '').endsWith('/en'),
    '/ redirects to /en — the proxy is running',
    `/ returned ${rootRes.status} → ${rootRes.headers.get('location')}. proxy.ts is not being invoked.`,
  )

  const guarded = await fetch(`${APP}/en/questions`, { redirect: 'manual' })
  check(
    (guarded.headers.get('location') ?? '').includes('/login'),
    'an anonymous visitor is sent to /login',
    `anonymous /en/questions → ${guarded.headers.get('location')}`,
  )

  // ── 0b. The signed-out screens ─────────────────────────────────────────────
  // These are the only pages in the product that an unapproved, unauthenticated
  // person can reach, and until now nothing rendered them. Two of the failures
  // below shipped and went unnoticed for exactly that reason.
  console.log('\n0b. Signed out')

  for (const locale of ['en', 'hi', 'gu']) {
    for (const path of ['/login', '/register', '/forgot-password', '/reset-password']) {
      const res = await fetch(`${APP}/${locale}${path}`, { redirect: 'manual' })
      const html = await res.text()
      check(res.status === 200, `${locale}${path} renders`, `${locale}${path} → ${res.status}`)
      check(
        !/MISSING_MESSAGE|IntlError/.test(html),
        `${locale}${path} resolves every message key`,
        `${locale}${path} is missing a translation key`,
      )
    }
  }

  // Four labels on the register form were hardcoded English in an application
  // whose whole point is that a Gujarati-speaking porter can use it. Asserted
  // against the Gujarati bundle, so "it renders" cannot pass by rendering
  // English.
  const guRegister = await (await fetch(`${APP}/gu/register`)).text()
  check(
    />ઈમેલ</.test(guRegister) && />પાસવર્ડ</.test(guRegister),
    'the register form is translated rather than hardcoded English',
    'the register form still renders English labels to a Gujarati reader',
  )

  // The page heading names the page. Every auth screen previously had the
  // product name as its only h1, so heading navigation told a screen-reader
  // user nothing about which of the five screens they were on.
  const loginHtml = await (await fetch(`${APP}/en/login`)).text()
  check(
    /<h1[^>]*>Sign in</.test(loginHtml),
    'the login page h1 names the page, not the product',
    'the login page h1 does not name the page',
  )
  // Language before sign-in: preferred_locale lives on the profile and cannot
  // be read until there is a session, so the URL is the only signal and this
  // control is the only way to change it.
  check(
    /aria-label="Language"/.test(loginHtml),
    'language can be changed before signing in',
    'there is no way to change language on the login page',
  )

  // ── The reset link ─────────────────────────────────────────────────────────
  // forgotPasswordAction has always pointed its email at /{locale}/reset-password
  // and that route did not exist, so every reset link this app ever sent hit a
  // 404. Asserted in both directions: the page exists, AND it refuses to offer
  // a password form to somebody who has not arrived with a usable link.
  const bareReset = await (await fetch(`${APP}/en/reset-password`)).text()
  check(
    />This link cannot be used</.test(bareReset),
    'reset-password with no link reports that it cannot be used',
    'reset-password did not report a missing link',
  )
  check(
    !/name="confirm"/.test(bareReset),
    'no password form is offered without a recovery link',
    'A PASSWORD FORM WAS OFFERED WITH NO RECOVERY LINK',
  )
  // Supabase signals a dead link by redirecting BACK to this URL with ?error=,
  // sometimes alongside a code. Reading only `code` would show the form to
  // somebody holding a link that has already been rejected.
  const deadReset = await (
    await fetch(`${APP}/en/reset-password?error=access_denied&error_code=otp_expired&code=abc`)
  ).text()
  check(
    />This link cannot be used</.test(deadReset),
    'an ?error= reset link is refused even when a code is present',
    'an expired reset link was treated as usable',
  )

  // ── 1. A real chef session ─────────────────────────────────────────────────
  console.log('\n1. Session')
  const email = `render-chef-${stamp}@bookends-test.local`
  const made = await fetch(`${URL_}/auth/v1/admin/users`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: 'Render Chef', locale: 'en' },
    }),
  })
  if (!made.ok) throw new Error(`create user: ${made.status} ${await made.text()}`)
  const user = await made.json()
  createdUsers.push(user.id)

  await db.query(
    `update public.profiles
        set approval_status='approved',
            outlet_id='00000000-0000-0000-0000-00000000a001',
            department_id=(select id from public.departments where slug='kitchen' limit 1)
      where id=$1`,
    [user.id],
  )
  await db.query(
    `insert into public.user_roles (user_id, role_id)
     select $1, id from public.roles where key='admin' on conflict do nothing`,
    [user.id],
  )
  await db.query(
    `delete from public.user_roles
      where user_id=$1 and role_id=(select id from public.roles where key='employee')`,
    [user.id],
  )

  const session = await (
    await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: PUB, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    })
  ).json()

  // Exactly what @supabase/ssr writes: `base64-` + base64URL of the session
  // JSON, split into 3180-character chunks named .0, .1, … Standard base64
  // here would be silently wrong — see decodeBase64Url in src/proxy.ts.
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
    return { status: res.status, location: res.headers.get('location'), html: await res.text() }
  }

  const dashboard = await get('/en/dashboard')
  check(
    dashboard.status === 200,
    'a signed-in chef reaches the dashboard',
    `dashboard returned ${dashboard.status} → ${dashboard.location}. ` +
      'A redirect to /pending means the session is not being read server-side.',
  )

  // ── 1b. The dashboard, per role ────────────────────────────────────────────
  //
  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ WHY AN HR PERSONA EXISTS ONLY IN THIS SECTION.                          │
  // │                                                                         │
  // │ Everything above runs as a chef, and a chef holds a superset of almost   │
  // │ every permission in the product. That is precisely why a whole class of  │
  // │ bug was invisible: a page that gates on `A || B` and then calls an       │
  // │ action guarded on `A` alone works perfectly for anyone holding A, and    │
  // │ 500s for whoever holds only B.                                          │
  // │                                                                         │
  // │ That shipped. /reports gated its team sections on                       │
  // │ `reports.read_team || reports.read_all`; getTeamStats, getExamStats and  │
  // │ getQuestionStats were guarded on read_team alone; HR holds read_all and  │
  // │ not read_team. /en/reports and /api/reports/export both returned 500 to  │
  // │ every HR user, and no check in this file could see it because no check   │
  // │ in this file had ever been anyone but a chef.                           │
  // │                                                                         │
  // │ /dashboard is where this matters most — it is the one route nobody can   │
  // │ route around — so it is asserted here for the role least like the one    │
  // │ the rest of the script uses.                                            │
  // └─────────────────────────────────────────────────────────────────────────┘
  console.log('\n1b. The dashboard, per role')

  const hrEmail = `render-hr-${stamp}@bookends-test.local`
  const hrMade = await fetch(`${URL_}/auth/v1/admin/users`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      email: hrEmail,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: 'Render HR', locale: 'en' },
    }),
  })
  if (!hrMade.ok) throw new Error(`create hr: ${hrMade.status} ${await hrMade.text()}`)
  const hrUser = await hrMade.json()
  createdUsers.push(hrUser.id)

  await db.query(`update public.profiles set approval_status='approved' where id=$1`, [hrUser.id])
  await db.query(
    `insert into public.user_roles (user_id, role_id)
     select $1, id from public.roles where key='hr' on conflict do nothing`,
    [hrUser.id],
  )
  await db.query(
    `delete from public.user_roles
      where user_id=$1 and role_id=(select id from public.roles where key='employee')`,
    [hrUser.id],
  )

  const hrSession = await (
    await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: PUB, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: hrEmail, password: PASSWORD }),
    })
  ).json()
  const hrCookie = `${cookieName}=base64-${Buffer.from(JSON.stringify(hrSession)).toString('base64url')}`
  const hrGet = async (path) => {
    const res = await fetch(`${APP}${path}`, { headers: { cookie: hrCookie }, redirect: 'manual' })
    return { status: res.status, location: res.headers.get('location'), html: await res.text() }
  }

  const hrDashboard = await hrGet('/en/dashboard')
  check(hrDashboard.status === 200, 'HR reaches the dashboard', `HR dashboard → ${hrDashboard.status}`)

  const hrReports = await hrGet('/en/reports')
  check(
    hrReports.status === 200,
    'HR reaches /reports — reports.read_all is accepted where read_team is',
    `HR /reports → ${hrReports.status}. A 500 means an action is still guarded on read_team alone ` +
      'while the page gates on read_team || read_all.',
  )

  const hrExport = await hrGet('/api/reports/export?dataset=team')
  check(
    hrExport.status === 200,
    'HR can export the team CSV they hold reports.export for',
    `HR export → ${hrExport.status}. 500 means the guards inside the route diverge from the one it catches.`,
  )

  /*
   * The POSITIVE half of this pair was removed on 10 Aug 2026 with the legacy
   * dashboard: there is no "To mark" tile any more, and asserting one made the
   * suite fail every run. The NEGATIVE half is kept and still means something —
   * whatever the dashboard grows next, HR must not be handed a queue they hold
   * no permission to act on.
   */
  check(
    !/>To mark</.test(hrDashboard.html),
    'HR is not shown a queue they hold no permission to act on',
    'HR WAS SHOWN A MARKING QUEUE THEY CANNOT ACT ON',
  )
  check(
    !/>To approve</.test(hrDashboard.html),
    'HR is not shown registration approvals',
    'HR WAS SHOWN REGISTRATION APPROVALS',
  )

  /*
   * ┌───────────────────────────────────────────────────────────────────────────┐
   * │ THE ASSERTION THAT WOULD HAVE CAUGHT THE HR NAVIGATION 500.               │
   * │                                                                           │
   * │ The Papers nav item is ORed on ['papers.generate','papers.read_history'], │
   * │ and pointed at /papers/generate for everybody. HR holds only the second,  │
   * │ so the sidebar offered them a link that returned 500 — for months, on the │
   * │ dashboard this very block already fetched.                                │
   * │                                                                           │
   * │ It went unnoticed because every OTHER check runs as an admin or a chef,   │
   * │ who hold both keys, and because the unit suite asserted the Papers href   │
   * │ only against ADMIN. This is the one authenticated HR session in the       │
   * │ repository, which makes it the right place for the assertion.             │
   * │                                                                           │
   * │ Asserted on the RENDERED DOCUMENT rather than the nav array: a link is    │
   * │ equally wrong in a sidebar, a tab bar or a dashboard tile, and the array  │
   * │ cannot see the last two.                                                  │
   * └───────────────────────────────────────────────────────────────────────────┘
   */
  check(
    !/href="\/en\/papers\/generate"/.test(hrDashboard.html),
    'HR is offered no link to the paper generator they cannot open',
    'HR WAS OFFERED /en/papers/generate, WHICH RETURNS 500 FOR THEM',
  )
  // The positive half. Without it, hiding the item entirely would pass the
  // check above while removing HR's only route into the history they hold
  // papers.read_history for.
  check(
    /href="\/en\/history"/.test(hrDashboard.html),
    'HR still reaches the paper history they are entitled to',
    'HR HAS NO ROUTE TO PAPER HISTORY AT ALL',
  )
  const hrHistory = await hrGet('/en/history')
  check(
    hrHistory.status === 200,
    'and that link actually opens',
    `HR got ${hrHistory.status} from the link they were offered`,
  )

  // The old dashboard printed the JWT `app` claim: a raw role-slug list and a
  // permission COUNT — which read "Permissions: 0" for a super_admin, because
  // that role is deliberately not enumerated and short-circuits in has_perm().
  // The single numeric datum on the page was inverted for the most powerful
  // user in the system.
  check(
    !/>Permissions: /.test(dashboard.html) && !/>Roles: /.test(dashboard.html),
    'the dashboard no longer prints the raw JWT claim at the user',
    'the dashboard is still dumping role slugs and a permission count',
  )

  for (const locale of ['en', 'hi', 'gu']) {
    const page = await get(`/${locale}/dashboard`)
    check(
      page.status === 200 && !/MISSING_MESSAGE|IntlError/.test(page.html),
      `${locale}/dashboard renders and resolves every message key`,
      `${locale}/dashboard → ${page.status}, or a translation key is missing`,
    )
  }

  /*
   * ┌───────────────────────────────────────────────────────────────────────────┐
   * │ THE EXECUTIVE OVERVIEW, THE HERO FIGURE, THE "Backend required" LABEL AND │
   * │ THE ACTIVITY-FEED NOTE ALL WENT WITH THE LEGACY DASHBOARD.                │
   * │                                                                           │
   * │ That page was replaced wholesale by the Stitch rebuild — its own header   │
   * │ comment says so — and these five assertions kept testing panels that no   │
   * │ longer render. They failed on every run for both roles.                   │
   * │                                                                           │
   * │ THE ONE BELOW IS KEPT, and it is the load-bearing one of the group: it    │
   * │ pins the literal figures from the design mock (94.2% pass rate, 88.4%     │
   * │ average, 1,284 exams, +10.8%). If any of them ever appears in the served  │
   * │ HTML, somebody has hard-coded the design's placeholder data into the      │
   * │ product — which on a page a manager uses to decide who needs retraining   │
   * │ is worse than an empty panel, and looks identical to working software.    │
   * │                                                                           │
   * │ It is not tied to any particular layout, so the rebuild did not touch it. │
   * └───────────────────────────────────────────────────────────────────────────┘
   */
  check(
    !/94\.2|88\.4|1,284|\+10\.8/.test(dashboard.html),
    'no figure from the design mock is being rendered as real data',
    'A NUMBER FROM THE DESIGN MOCK IS BEING SHOWN AS IF IT WERE REAL',
  )

  // ── 2. Seed a question ─────────────────────────────────────────────────────
  const stem = `Render check ${stamp}: which oil has the highest smoke point?`
  const saved = await (
    await fetch(`${URL_}/rest/v1/rpc/save_question`, {
      method: 'POST',
      headers: {
        apikey: PUB,
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        p_id: null,
        p_type: 'mcq_single',
        p_response_format: 'choice_single',
        p_stem: stem,
        p_content: {
          format: 'choice_single',
          choices: [
            { id: 'a', text: 'Rice bran' },
            { id: 'b', text: 'Extra virgin olive' },
          ],
        },
        p_answer_key: { format: 'choice_single', correct: 'a' },
        p_category_id: RENDER_CAT,
        p_change_note: 'seeded by the render check',
      }),
    })
  ).json()
  const questionId = saved?.[0]?.id
  if (questionId) createdQuestions.push(questionId)


  /*
   * ┌───────────────────────────────────────────────────────────────────────────┐
   * │ THE LEGACY QUESTION-BANK AND EDITOR ASSERTIONS WERE REMOVED ON 10 AUG     │
   * │ 2026, BECAUSE THE SCREENS THEY TESTED NO LONGER EXIST.                    │
   * │                                                                           │
   * │ They checked /en/questions for a category filter, a Bloom filter, a       │
   * │ source filter, and Languages / Health / Created by / Fixed papers         │
   * │ columns — the legacy question bank. That route now serves the REBUILT     │
   * │ bank, which has none of those by design, so all 45 assertions failed      │
   * │ against a product that had been deliberately replaced. A suite that       │
   * │ reports 45 failures every run reports nothing at all.                     │
   * │                                                                           │
   * │ WHAT COVERS THE NEW BANK INSTEAD, so this is a move rather than a loss:   │
   * │   scripts/check-audit.mjs   — import, export, round trip, data integrity  │
   * │   scripts/check-shell.mjs   — every bank route, as a Chef and signed out  │
   * │   scripts/check-authz.mjs   — the permission matrix by direct URL         │
   * │   tests/unit/              — the schemas, the registry, the message keys  │
   * │                                                                           │
   * │ The seeded question above is NOT removed: questionId and stem are still   │
   * │ used by the exam, delivery and translation checks further down.           │
   * └───────────────────────────────────────────────────────────────────────────┘
   */

  /*
   * ┌───────────────────────────────────────────────────────────────────────────┐
   * │ THE GUIDE (AI) ASSERTIONS WERE REMOVED ON 11 AUG 2026 — THE FEATURE IS    │
   * │ GONE, NOT MERELY MOVED.                                                   │
   * │                                                                           │
   * │ /guide, its upload dialog and its four tables (0048/0050) were deleted in │
   * │ the consolidation, and migration 0068 dropped source_documents,           │
   * │ document_chunks, generation_jobs and generation_candidates. Questions now  │
   * │ come from the bank and nowhere else, which is a frozen product decision.   │
   * │                                                                           │
   * │ Its four checks — the page rendering, the message sweep, the tab hrefs,   │
   * │ the unknown-tab fallback — plus the candidate refusal further down were    │
   * │ all testing a 404. Nothing replaces them because nothing replaces the      │
   * │ feature.                                                                  │
   * └───────────────────────────────────────────────────────────────────────────┘
   */

  // ── 4. An exam to deliver ──────────────────────────────────────────────────
  //
  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ THE AUTHORING SCREENS WERE REMOVED ON 10 AUG 2026. THE EXAM WAS NOT.    │
  // │                                                                         │
  // │ /exams, /exams/new and /exams/[id] are gone: a paper is now generated on │
  // │ /papers/generate and published straight from the success screen, so      │
  // │ there is no section builder, no health panel and no per-exam settings    │
  // │ page left to render. Sections 4–7 used to assert on exactly those, and   │
  // │ every one of those assertions was testing a 404.                        │
  // │                                                                         │
  // │ WHAT IS KEPT, AND WHY IT IS NOT A DELETION: the exam this block builds   │
  // │ is the fixture the whole candidate half of this file runs on — section 8 │
  // │ sits it, section 9 marks it. It is now built through the database and    │
  // │ published through the real publish_exam RPC, which is the same contract  │
  // │ the deleted page invoked. The publish semantics (status moves to         │
  // │ scheduled, the paper is frozen and counted) are still asserted below.    │
  // │                                                                         │
  // │ The leak checks that used to run against the authoring paper preview are │
  // │ NOT lost either: section 8 runs the identical sweep against the live     │
  // │ paper, which is the surface where a leaked key actually costs an exam.   │
  // └─────────────────────────────────────────────────────────────────────────┘
  console.log('\n4. An exam to deliver')

  // ACTIVATED HERE, not at seed time. save_question() creates drafts and
  // draw_paper() only ever selects status='active' — a draft is not eligible
  // for an exam, by design — so the exam checks below need an active question.
  // Doing it earlier would break the question-bank filter assertions above,
  // which deliberately exercise a DRAFT.
  if (questionId) {
    await db.query(`update public.questions set status='active' where id=$1`, [questionId])
  }

  // The deleted routes must actually be gone, not merely unlinked. A page left
  // behind after its nav entry is removed is still reachable by anyone who
  // guesses the URL, and this is the cheapest possible proof that it is not.
  for (const dead of ['/en/exams', '/en/exams/new']) {
    const res = await get(dead)
    check(res.status === 404, `${dead} is gone`, `${dead} still answers ${res.status}`)
  }

  const examTitle = `Render check exam ${stamp}`
  const { rows: examRows } = await db.query(
    `insert into public.exams (company_id, title, created_by, kind, duration_minutes)
     values ($1,$2,$3,'official',30) returning id`,
    [
      '00000000-0000-0000-0000-00000000c001',
      examTitle,
      user.id,
    ],
  )
  const examId = examRows[0].id
  createdExams.push(examId)

  // One section, one rule, one question — the smallest exam that can be drawn.
  // The old two-rule form existed to starve the second rule and prove the
  // health panel reported the shortfall; there is no health panel to report it
  // to any more, and publish_exam's own refusal is covered by the RLS suite.
  const { rows: sectionRows } = await db.query(
    `insert into public.exam_sections (exam_id, title, sort_order)
     values ($1,'Render check section',0) returning id`,
    [examId],
  )
  await db.query(
    `insert into public.exam_rules (section_id, category_id, question_count, difficulty_min, difficulty_max, sort_order)
     values ($1,$2,1,1,5,0)`,
    [sectionRows[0].id, RENDER_CAT],
  )
  await db.query(
    `insert into public.exam_assignments (exam_id, target_kind, target_id)
     values ($1,'outlet','00000000-0000-0000-0000-00000000a001')`,
    [examId],
  )

  // ── Publish, through the real RPC ──────────────────────────────────────────
  const published = await fetch(`${URL_}/rest/v1/rpc/publish_exam`, {
    method: 'POST',
    headers: {
      apikey: PUB,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_exam_id: examId }),
  })
  const publishBody = await published.json()
  check(
    published.status === 200,
    'publish_exam succeeds for a healthy exam',
    `publish returned ${published.status}: ${JSON.stringify(publishBody)?.slice(0, 200)}`,
  )

  const { rows: afterPublish } = await db.query(
    'select status, question_count from public.exams where id = $1',
    [examId],
  )
  check(
    afterPublish[0]?.status === 'scheduled',
    'the exam moves to scheduled',
    `status is ${afterPublish[0]?.status}`,
  )
  check(afterPublish[0]?.question_count === 1, 'the frozen paper is counted', 'question_count is wrong')

  // Immutability, asserted where it is actually enforced. The old checks read
  // it off the settings form — no opens_at input, no timezone control, Save
  // gone — which tested a page's honesty about a rule rather than the rule.
  // 0016's trigger is the rule, and it answers over the wire.
  const tamper = await fetch(`${URL_}/rest/v1/exams?id=eq.${examId}`, {
    method: 'PATCH',
    headers: {
      apikey: PUB,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ duration_minutes: 999 }),
  })
  check(
    tamper.status !== 200,
    'a published exam refuses a change to its frozen settings',
    `PATCHing a published exam returned ${tamper.status} — the paper is not immutable`,
  )

  // ── 7. The frozen paper ────────────────────────────────────────────────────
  //
  // The authoring-side preview is gone with /exams/[id], so provenance and the
  // per-question revision are asserted against the stored paper rather than a
  // rendered one. The LEAK sweep is not asserted here at all — it moved to
  // section 8, against the live paper served to the candidate, which is the
  // surface where a leak actually costs an exam.
  console.log('\n7. The frozen paper')

  const { rows: frozenPaper } = await db.query(
    `select eq.question_revision, q.stem
       from public.exam_questions eq
       join public.questions q on q.id = eq.question_id
      where eq.exam_id = $1`,
    [examId],
  )
  check(frozenPaper.length === 1, 'exactly one question was frozen', `${frozenPaper.length} questions frozen`)
  check(frozenPaper[0]?.stem === stem, 'the frozen question is the one that was seeded', 'the wrong question was drawn')
  check(
    frozenPaper[0]?.question_revision === 1,
    'the frozen question carries its revision',
    `revision ${frozenPaper[0]?.question_revision}`,
  )

  const { rows: provenance } = await db.query(
    `select p.full_name, e.published_at
       from public.exams e join public.profiles p on p.id = e.published_by
      where e.id = $1`,
    [examId],
  )
  check(
    provenance[0]?.full_name === 'Render Chef' && provenance[0]?.published_at !== null,
    'the exam records who published it and when',
    `publisher provenance is ${JSON.stringify(provenance[0])}`,
  )

  // ── 8. Sitting the exam, as a candidate ────────────────────────────────────
  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ THE ONE THAT MATTERS. Everything before this renders the AUTHORING side, │
  // │ where the person looking is allowed to know the answers. This renders    │
  // │ the live paper to the person being tested — the only screen in the       │
  // │ product where a leaked key is a scored exam thrown away.                 │
  // └─────────────────────────────────────────────────────────────────────────┘
  console.log('\n8. Candidate delivery')

  const candEmail = `render-cand-${stamp}@bookends-test.local`
  const candMade = await fetch(`${URL_}/auth/v1/admin/users`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      email: candEmail,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: 'Render Candidate', locale: 'en' },
    }),
  })
  if (!candMade.ok) throw new Error(`create candidate: ${candMade.status} ${await candMade.text()}`)
  const candUser = await candMade.json()
  createdUsers.push(candUser.id)

  // Approved, in the outlet the exam was assigned to, and left on the default
  // employee role — no chef permissions anywhere in this section.
  await db.query(
    `update public.profiles
        set approval_status='approved',
            outlet_id='00000000-0000-0000-0000-00000000a001',
            department_id=(select id from public.departments where slug='kitchen' limit 1)
      where id=$1`,
    [candUser.id],
  )

  const candSession = await (
    await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: PUB, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: candEmail, password: PASSWORD }),
    })
  ).json()

  const candEncoded =
    'base64-' + Buffer.from(JSON.stringify(candSession)).toString('base64url')
  const candParts = []
  for (let i = 0; i < candEncoded.length; i += 3180) candParts.push(candEncoded.slice(i, i + 3180))
  const candCookie =
    candParts.length === 1
      ? `${cookieName}=${candParts[0]}`
      : candParts.map((p, i) => `${cookieName}.${i}=${p}`).join('; ')

  const candGet = async (path) => {
    const res = await fetch(`${APP}${path}`, { headers: { cookie: candCookie }, redirect: 'manual' })
    return { status: res.status, location: res.headers.get('location'), html: await res.text() }
  }

  // M9: the quality dashboard reports how every candidate answered every
  // question, aggregated across the outlet. A candidate holds neither
  // questions.read nor an analytics scope, and must be turned away by the page
  // guard before question_quality's own check ever runs.
  const candQuality = await candGet('/en/questions/quality')
  check(
    candQuality.status !== 200,
    'a candidate cannot open the quality dashboard',
    `a candidate got ${candQuality.status} from /questions/quality`,
  )

  // The bank is where every question comes from now. A candidate holds no
  // questions.read and must be turned away by the page guard — this is the
  // refusal that used to be asserted against /guide.
  const candBank = await candGet('/en/questions')
  check(
    candBank.status !== 200,
    'a candidate cannot open the question bank',
    `a candidate got ${candBank.status} from /questions`,
  )

  const myExams = await candGet('/en/my-exams')
  check(
    myExams.status === 200,
    '/en/my-exams renders for a candidate',
    `status ${myExams.status} → ${myExams.location}`,
  )
  check(
    myExams.html.includes(examTitle),
    'the assigned exam appears on the candidate list',
    'the assigned exam was not listed for the candidate',
  )
  check(
    !/MISSING_MESSAGE|IntlError/.test(myExams.html),
    'every message key resolves on the candidate list',
    'a translation key is missing',
  )

  // Start through the real RPC with the candidate's own token — the same call
  // the Start button makes.
  const startRes = await fetch(`${URL_}/rest/v1/rpc/start_attempt`, {
    method: 'POST',
    headers: {
      apikey: PUB,
      Authorization: `Bearer ${candSession.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_exam_id: examId }),
  })
  const startBody = await startRes.json()
  const attemptId = Array.isArray(startBody) ? startBody[0]?.attempt_id : null
  check(
    Boolean(attemptId),
    'a candidate can start an attempt on an assigned exam',
    `start_attempt returned ${startRes.status}: ${JSON.stringify(startBody)?.slice(0, 200)}`,
  )

  if (attemptId) {
    const paper = await candGet(`/en/attempt/${attemptId}`)
    check(
      paper.status === 200,
      '/en/attempt/[id] renders the live paper',
      `status ${paper.status} → ${paper.location}`,
    )
    check(
      paper.html.includes(stem),
      'the candidate sees the question they were served',
      'the question did not render on the live paper',
    )
    check(
      paper.html.includes('Rice bran'),
      'the answer controls are mounted, options and all',
      'the options did not render on the live paper',
    )
    // role="timer" is produced only by the countdown component actually
    // mounting — unlike a label, it cannot come from the message bundle.
    check(
      /role="timer"/.test(paper.html),
      'the countdown is mounted',
      'the countdown did not render',
    )

    // ── What a candidate who cannot see the screen gets ────────────────────
    //
    // ┌───────────────────────────────────────────────────────────────────────┐
    // │ THESE ARE ASSERTED BECAUSE NOTHING ELSE CAN SEE THEM.                 │
    // │                                                                       │
    // │ Accessibility work is invisible to every other check in this repo: the │
    // │ page renders, the tests pass, the build is green, and a screen-reader  │
    // │ user still cannot tell which questions they have answered. So the      │
    // │ properties that make this screen usable without sight are pinned here, │
    // │ in the same file that pins the answer-key leak.                       │
    // └───────────────────────────────────────────────────────────────────────┘

    // The countdown must NOT be a live region. A number changing once a second
    // inside one is announced once a second, which makes the exam unusable —
    // the thresholds are spoken separately instead.
    check(
      /role="timer"[^>]*aria-live="off"|aria-live="off"[^>]*role="timer"/.test(paper.html),
      'the ticking countdown is silent, so it cannot talk over the candidate',
      'the countdown is a live region and will announce every second',
    )
    // The save indicator's wrapper is in the DOM from first paint. A live
    // region inserted at the same moment as its first message is routinely
    // missed, because the screen reader was not observing the node yet.
    check(
      /role="status"[^>]*aria-live="polite"/.test(paper.html),
      'the save-state live region exists before it has anything to say',
      'the save indicator is only mounted once it has a message, which is announced to nobody',
    )
    // The question is a real heading and can be jumped to. CardTitle renders a
    // <div>, so before this the thing being answered was not a heading at all.
    check(
      /<h2[^>]*tabindex="-1"/i.test(paper.html),
      'the question is a focusable heading, so moving between questions lands somewhere',
      'the question stem is not a focusable heading',
    )
    // Answered-ness is in the accessible NAME, not only in the fill colour.
    check(
      /aria-label="Question \d+, (answered|not answered|current)"/.test(paper.html),
      'the navigator says whether each question is answered, in words',
      'the navigator distinguishes answered from unanswered by colour alone',
    )
    check(
      /<nav aria-label="Questions">/.test(paper.html),
      'the question navigator is a landmark',
      'the navigator is not reachable as a landmark',
    )

    // THE ASSERTION THIS SECTION EXISTS FOR.
    for (const forbidden of ['"correct"', '"model_answer"', '"rubric"', '"accept"']) {
      check(
        !paper.html.includes(forbidden),
        `the live paper contains no ${forbidden}`,
        `THE LIVE PAPER LEAKED ${forbidden} TO THE CANDIDATE`,
      )
    }

    // ── The release gate, in the browser ────────────────────────────────────
    // This exam carries the default verification_mode of 'dual', so submitting
    // it leaves the paper at 'auto_graded' — marked, and deliberately not
    // released. The candidate must be told it is pending and shown no verdict.
    await fetch(`${URL_}/rest/v1/rpc/submit_attempt`, {
      method: 'POST',
      headers: {
        apikey: PUB,
        Authorization: `Bearer ${candSession.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_attempt_id: attemptId, p_reason: 'user' }),
    })

    const held = await candGet(`/en/attempt/${attemptId}`)
    check(
      />Your result has not been released/.test(held.html),
      'an unreleased result tells the candidate it is pending',
      'the pending message is missing after submitting',
    )
    // Text nodes, not includes(): every page serialises the whole next-intl
    // bundle, so `includes('Passed')` is true even on a blank page.
    check(
      !/>Passed</.test(held.html) && !/>Not passed</.test(held.html),
      'no verdict is shown before the result is released',
      'A VERDICT LEAKED BEFORE PUBLICATION',
    )

    // A candidate must not reach an attempt that is not theirs, and "not yours"
    // and "does not exist" must look identical from outside.
    const notMine = await candGet('/en/attempt/00000000-0000-0000-0000-0000000000ff')
    check(
      notMine.status === 404,
      'an attempt that is not yours 404s',
      `status ${notMine.status} for a foreign attempt`,
    )
  }

  // The authoring side must stay closed to them, or the separation of the two
  // halves of the product is cosmetic. /exams/live replaced /exams as the
  // supervisor's view of who is sitting what, and /papers/generate replaced
  // /exams/new as the place a paper is made.
  for (const closed of ['/en/exams/live', '/en/exams/upcoming', '/en/exams/closed', '/en/papers/generate']) {
    const res = await candGet(closed)
    check(res.status !== 200, `a candidate cannot open ${closed}`, `a candidate got ${res.status} on ${closed}`)
  }

  // ── 9. The whole loop ─────────────────────────────────────────────────────
  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ M4 END TO END, THROUGH THE BROWSER.                                     │
  // │                                                                         │
  // │ sit → submit → evaluate → verify → publish → the candidate sees a mark. │
  // │ Every earlier section proves one screen; this proves they join up, and  │
  // │ that the result stays invisible until the last step in the chain says   │
  // │ otherwise.                                                              │
  // └─────────────────────────────────────────────────────────────────────────┘
  console.log('\n9. Evaluation, verification and release')

  // A second chef, so the verifier is not the evaluator. The database refuses
  // that combination and this is how the check gets an honest signature.
  const verEmail = `render-ver-${stamp}@bookends-test.local`
  const verMade = await fetch(`${URL_}/auth/v1/admin/users`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      email: verEmail,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: 'Render Verifier', locale: 'en' },
    }),
  })
  if (!verMade.ok) throw new Error(`create verifier: ${verMade.status} ${await verMade.text()}`)
  const verUser = await verMade.json()
  createdUsers.push(verUser.id)

  await db.query(
    `update public.profiles
        set approval_status='approved',
            outlet_id='00000000-0000-0000-0000-00000000a001',
            department_id=(select id from public.departments where slug='kitchen' limit 1)
      where id=$1`,
    [verUser.id],
  )
  await db.query(
    `insert into public.user_roles (user_id, role_id)
     select $1, id from public.roles where key='admin' on conflict do nothing`,
    [verUser.id],
  )
  await db.query(
    `delete from public.user_roles
      where user_id=$1 and role_id=(select id from public.roles where key='employee')`,
    [verUser.id],
  )

  const verSession = await (
    await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: PUB, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: verEmail, password: PASSWORD }),
    })
  ).json()
  const verEncoded = 'base64-' + Buffer.from(JSON.stringify(verSession)).toString('base64url')
  const verParts = []
  for (let i = 0; i < verEncoded.length; i += 3180) verParts.push(verEncoded.slice(i, i + 3180))
  const verCookie =
    verParts.length === 1
      ? `${cookieName}=${verParts[0]}`
      : verParts.map((p, i) => `${cookieName}.${i}=${p}`).join('; ')
  const verGet = async (path) => {
    const res = await fetch(`${APP}${path}`, { headers: { cookie: verCookie }, redirect: 'manual' })
    return { status: res.status, location: res.headers.get('location'), html: await res.text() }
  }

  // An essay, so the paper needs a person.
  const essayStem = `Render check ${stamp}: describe the danger zone.`
  const rubricLabel = `Names 5 to 63 degrees ${stamp}`
  const { rows: essayRows } = await db.query(
    `insert into public.questions
       (company_id, type, response_format, stem, content, category_id,
        difficulty, marks, status, created_by)
     values ($1,'essay','text_long',$2,$3::jsonb,$4,3,5,'active',$5)
     returning id`,
    [
      '00000000-0000-0000-0000-00000000c001',
      essayStem,
      JSON.stringify({ format: 'text_long', maxWords: 100 }),
      RENDER_CAT,
      user.id,
    ],
  )
  const essayId = essayRows[0].id
  createdQuestions.push(essayId)
  await db.query(
    `insert into public.question_answer_keys (question_id, answer_key) values ($1,$2::jsonb)`,
    [essayId, JSON.stringify({ format: 'text_long', rubric: [{ id: 'r1', label: rubricLabel, max: 5 }] })],
  )

  // 'single' so one signature completes it — the two-signature path is covered
  // exhaustively in the integration suite.
  const { rows: essayExamRows } = await db.query(
    `insert into public.exams
       (company_id, title, created_by, kind, duration_minutes, paper_mode,
        max_attempts, pass_mark_percent, verification_mode, closes_at)
     values ($1,$2,$3,'official',30,'fixed',3,50,'single', now() + interval '1 day')
     returning id`,
    ['00000000-0000-0000-0000-00000000c001', `Render check essay exam ${stamp}`, user.id],
  )
  const essayExamId = essayExamRows[0].id
  createdExams.push(essayExamId)

  const { rows: essaySection } = await db.query(
    `insert into public.exam_sections (exam_id, title, sort_order)
     values ($1,'Essay section',0) returning id`,
    [essayExamId],
  )
  await db.query(
    `insert into public.exam_rules
       (section_id, category_id, question_count, difficulty_min, difficulty_max, question_types)
     values ($1,$2,1,1,5,$3::public.question_type[])`,
    [essaySection[0].id, RENDER_CAT, ['essay']],
  )
  await db.query(
    `insert into public.exam_assignments (exam_id, target_kind, target_id)
     values ($1,'outlet','00000000-0000-0000-0000-00000000a001')`,
    [essayExamId],
  )

  const essayPublished = await fetch(`${URL_}/rest/v1/rpc/publish_exam`, {
    method: 'POST',
    headers: {
      apikey: PUB,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_exam_id: essayExamId }),
  })
  check(
    essayPublished.status === 200,
    'the essay exam publishes',
    `publish returned ${essayPublished.status}`,
  )

  const candRpc = (name, body) =>
    fetch(`${URL_}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: PUB,
        Authorization: `Bearer ${candSession.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

  const essayStart = await (await candRpc('start_attempt', { p_exam_id: essayExamId })).json()
  const essayAttempt = Array.isArray(essayStart) ? essayStart[0]?.attempt_id : null
  check(Boolean(essayAttempt), 'the candidate starts the essay exam', 'start_attempt failed')

  await candRpc('save_answer', {
    p_attempt_id: essayAttempt,
    p_question_id: essayId,
    p_answer: { format: 'text_long', text: 'Between 5 and 63 degrees celsius.' },
  })
  await candRpc('submit_attempt', { p_attempt_id: essayAttempt, p_reason: 'user' })

  const { rows: afterSubmit } = await db.query(
    'select status from public.attempts where id=$1',
    [essayAttempt],
  )
  check(
    afterSubmit[0]?.status === 'evaluating',
    'a paper with an essay goes to evaluation',
    `status is ${afterSubmit[0]?.status}`,
  )

  // ── The evaluator's screens ──────────────────────────────────────────────
  const queue = await get('/en/evaluate')
  check(queue.status === 200, '/en/evaluate renders', `status ${queue.status} → ${queue.location}`)
  check(
    queue.html.includes('Render Candidate'),
    'the paper appears in the marking queue',
    'the submitted paper is not in the queue',
  )
  check(
    !/MISSING_MESSAGE|IntlError/.test(queue.html),
    'every message key resolves on the marking queue',
    'a translation key is missing',
  )

  const marking = await get(`/en/evaluate/${essayAttempt}`)
  check(marking.status === 200, '/en/evaluate/[id] renders', `status ${marking.status}`)
  check(
    marking.html.includes(essayStem),
    'the marking screen shows the question',
    'the question did not render on the marking screen',
  )
  check(
    marking.html.includes('Between 5 and 63 degrees celsius.'),
    'the marking screen shows what the candidate wrote',
    'the candidate answer did not render',
  )
  // The evaluator is the ONE role allowed to see this, and only for a question
  // no machine could mark.
  check(
    marking.html.includes(rubricLabel),
    'the evaluator is given the marking guide',
    'the rubric did not reach the evaluator',
  )

  // A candidate must not reach any of it.
  const candEvaluate = await candGet('/en/evaluate')
  check(
    candEvaluate.status !== 200,
    'a candidate cannot open the marking queue',
    `a candidate got ${candEvaluate.status} on /en/evaluate`,
  )

  // ── Mark it, then verify it ──────────────────────────────────────────────
  const chefRpc = (name, body, token = session.access_token) =>
    fetch(`${URL_}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: PUB,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

  await chefRpc('save_evaluation', {
    p_attempt_id: essayAttempt,
    p_question_id: essayId,
    p_score: 4,
    p_note: 'Good.',
  })
  const completed = await chefRpc('complete_evaluation', { p_attempt_id: essayAttempt })
  check(
    completed.status === 200,
    'evaluation completes',
    `complete_evaluation returned ${completed.status}: ${(await completed.text()).slice(0, 160)}`,
  )

  // Still not the candidate's to see.
  const midway = await candGet(`/en/attempt/${essayAttempt}`)
  check(
    />Your result has not been released/.test(midway.html),
    'a marked but unverified result stays hidden from the candidate',
    'A MARKED RESULT LEAKED BEFORE VERIFICATION',
  )

  // ── /results before release ──────────────────────────────────────────────
  // Marked, not yet signed off. The result must be listed as pending, carry no
  // number, and its detail page must 404 — "not yours" and "not released" are
  // deliberately indistinguishable from outside.
  const resultsPending = await candGet('/en/results')
  check(
    resultsPending.status === 200,
    '/en/results renders for a candidate',
    `status ${resultsPending.status} → ${resultsPending.location}`,
  )
  check(
    resultsPending.html.includes(`Render check essay exam ${stamp}`),
    'an unreleased attempt is listed on /en/results',
    'the attempt is missing from the results list',
  )
  check(
    />Awaiting release</.test(resultsPending.html),
    'an unreleased result is marked as pending',
    'the pending state is missing on the results list',
  )
  check(
    !/>Passed</.test(resultsPending.html) && !/>Not passed</.test(resultsPending.html),
    'no verdict appears on the results list before release',
    'A VERDICT LEAKED ONTO THE RESULTS LIST BEFORE RELEASE',
  )

  const detailBefore = await candGet(`/en/results/${essayAttempt}`)
  check(
    detailBefore.status === 404,
    'the result detail 404s before release',
    `status ${detailBefore.status} for an unreleased result`,
  )

  const verifyQueue = await verGet('/en/verify')
  check(verifyQueue.status === 200, '/en/verify renders', `status ${verifyQueue.status}`)
  check(
    verifyQueue.html.includes('Render Candidate'),
    'the marked paper appears in the verification queue',
    'the marked paper is not awaiting verification',
  )
  check(
    !/MISSING_MESSAGE|IntlError/.test(verifyQueue.html),
    'every message key resolves on the verification queue',
    'a translation key is missing',
  )

  // The evaluator sees it too, but is told it is not theirs to sign.
  const ownWork = await get('/en/verify')
  check(
    ownWork.html.includes('You marked this paper'),
    'the evaluator is told they cannot sign off their own marking',
    'the separation-of-duties notice is missing',
  )

  const signed = await chefRpc(
    'verify_attempt',
    { p_attempt_id: essayAttempt, p_decision: 'verified', p_note: 'Agreed.' },
    verSession.access_token,
  )
  check(signed.status === 200, 'the verifier signs it off', `verify returned ${signed.status}`)

  const { rows: finalRow } = await db.query(
    'select status, published_at from public.attempts where id=$1',
    [essayAttempt],
  )
  check(
    finalRow[0]?.status === 'published',
    'a single sign-off publishes the result',
    `status is ${finalRow[0]?.status}`,
  )

  // ── And now, at last, the candidate sees it ──────────────────────────────
  const released = await candGet(`/en/attempt/${essayAttempt}`)
  check(
    !/>Your result has not been released/.test(released.html),
    'the published result is no longer pending for the candidate',
    'the result still reads as pending after publication',
  )
  check(
    />Passed</.test(released.html) || />Not passed</.test(released.html),
    'the candidate is shown the verdict once it is published',
    'no verdict rendered after publication',
  )

  // ── /results after release ───────────────────────────────────────────────
  const resultsReleased = await candGet('/en/results')

  // Scoped to the essay card, not the whole page. This candidate also sat the
  // mcq exam in section 8, which defaults to dual verification and is still
  // held — so 'Awaiting release' is legitimately on this page, for that row.
  // Asserting over the whole document would call a correct page broken.
  const essayCardStart = resultsReleased.html.indexOf(`Render check essay exam ${stamp}`)
  const nextCardStart = resultsReleased.html.indexOf(`Render check exam ${stamp}`, essayCardStart)
  const essayCard = resultsReleased.html.slice(
    essayCardStart,
    nextCardStart > essayCardStart ? nextCardStart : undefined,
  )

  check(
    essayCardStart !== -1,
    'the released result is listed',
    'the released result is missing from /en/results',
  )
  check(
    !/>Awaiting release</.test(essayCard),
    'the released result no longer reads as pending',
    'the released result still shows as awaiting release',
  )
  check(
    />Passed</.test(essayCard),
    'the verdict appears on the results list once released',
    'the verdict is missing from the released result',
  )

  // ── Where you stand, and who you may not see ──────────────────────────────
  //
  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ THE ASSERTIONS THAT MATTER HERE ARE THE NEGATIVE ONES.                  │
  // │                                                                         │
  // │ 0036's my_standing() exists so a candidate can be told where they stand │
  // │ WITHOUT being told anything about a colleague. A rank is the most        │
  // │ disclosive statistic there is about an ordering: "3rd of 4" is the exact │
  // │ statement that two named people scored above you, and in a kitchen the   │
  // │ reader can put names to them by looking up.                            │
  // │                                                                         │
  // │ So the checks are: the candidate sees their own standing; the candidate  │
  // │ sees NO colleague's name; and the chef — who is entitled — does. The     │
  // │ last one is the positive control, without which the middle assertion     │
  // │ would pass just as well against a page that failed to render at all.    │
  // └─────────────────────────────────────────────────────────────────────────┘
  check(
    />Where you stand</.test(resultsReleased.html),
    'a candidate is shown their own standing',
    'the standing card is missing for a candidate with a released result',
  )
  // This run creates far fewer than ten people with released results, so the
  // floor must fire. Asserting the suppressed copy pins that the withholding
  // path is the one being exercised — the alternative is a check that only
  // ever sees the happy path and silently stops testing the interesting one.
  check(
    />Not enough participants yet</.test(resultsReleased.html),
    'below ten participants the position is withheld, with a reason given',
    'a rank was shown in a cohort too small to publish one',
  )
  check(
    !/>Render Chef</.test(resultsReleased.html) &&
      !/>Render Verifier</.test(resultsReleased.html),
    'a candidate is shown no colleague by name',
    'A COLLEAGUE’S NAME APPEARED ON A CANDIDATE’S RESULTS PAGE',
  )
  // The positive control, and it has to name the CANDIDATE, not the chef.
  // The chef has sat nothing, and the board ranks only people with a result —
  // so asserting the chef's own name would fail against a perfectly correct
  // board. The candidate is the one person in this run who has a released
  // result, which makes them the only name that can legitimately appear.
  const chefResults = await get('/en/results')
  check(
    />Render Candidate</.test(chefResults.html),
    'a chef reaches the ranked board, and it names the person on it',
    'the leaderboard did not render for a chef — so the negative check above proves nothing',
  )

  // ── The candidate's dashboard, now that they have a released result ───────
  //
  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ WHY A RAW-KEY SWEEP AND NOT JUST A MISSING_MESSAGE SWEEP.               │
  // │                                                                         │
  // │ The dashboard's verdict badge called tr('failed') against the `reports`  │
  // │ namespace, which has `passed` and no `failed`. next-intl does not throw  │
  // │ for that and does not render "MISSING_MESSAGE": use-intl's default       │
  // │ getMessageFallback returns the joined key path, so the badge shown to a  │
  // │ candidate who had just failed an exam read, literally, "reports.failed". │
  // │ Every existing sweep in this file looks for MISSING_MESSAGE or           │
  // │ IntlError, and the fallback string contains neither.                    │
  // │                                                                         │
  // │ This catches the whole class rather than the one instance: any          │
  // │ `namespace.key` rendered as a bare text node, for every namespace that   │
  // │ exists.                                                                 │
  // └─────────────────────────────────────────────────────────────────────────┘
  const NAMESPACES =
    'app|common|auth|dashboard|questions|exams|nav|errors|sitting|evaluation|results|reports|translations'
  const rawKey = new RegExp(`>(${NAMESPACES})\\.[a-zA-Z][a-zA-Z0-9_.]*<`)

  const candDashboard = await candGet('/en/dashboard')
  check(
    candDashboard.status === 200,
    "a candidate reaches their dashboard",
    `candidate dashboard → ${candDashboard.status}`,
  )
  check(
    !rawKey.test(candDashboard.html),
    'the dashboard renders no untranslated key path',
    `A RAW MESSAGE KEY IS BEING SHOWN TO THE USER: ${candDashboard.html.match(rawKey)?.[0]}`,
  )
  check(
    !rawKey.test(dashboard.html),
    "the chef's dashboard renders no untranslated key path",
    `A RAW MESSAGE KEY IS BEING SHOWN TO THE USER: ${dashboard.html.match(rawKey)?.[0]}`,
  )
  /*
   * ┌───────────────────────────────────────────────────────────────────────────┐
   * │ MOVED FROM THE DASHBOARD TO /results, WHICH IS WHERE THE VERDICT LIVES.  │
   * │                                                                           │
   * │ This asserted ">Passed<" on the candidate's DASHBOARD. The rebuilt        │
   * │ candidate dashboard shows what to sit next, not what was scored — the     │
   * │ verdict moved to /results — so the assertion failed on a page that is no  │
   * │ longer wrong, only different.                                             │
   * │                                                                           │
   * │ It is re-pointed rather than deleted: "a released result actually shows   │
   * │ its verdict to the person who sat it" is worth testing wherever it lands, │
   * │ and the candidate passed the essay exam above, so 'Passed' is the         │
   * │ direction that must appear. The FAIL branch is covered by the raw-key     │
   * │ sweep just above, which is what originally caught the bug here.           │
   * └───────────────────────────────────────────────────────────────────────────┘
   */
  const candResults = await candGet('/en/results')
  check(
    candResults.status === 200,
    'a candidate reaches their results',
    `candidate results → ${candResults.status}`,
  )
  check(
    />Passed</.test(candResults.html),
    'the results page shows the verdict on a released result',
    'the released verdict is missing from the results page',
  )
  check(
    !rawKey.test(candResults.html),
    'the results page renders no untranslated key path',
    `A RAW MESSAGE KEY IS BEING SHOWN TO THE USER: ${candResults.html.match(rawKey)?.[0]}`,
  )

  const detailAfter = await candGet(`/en/results/${essayAttempt}`)
  check(detailAfter.status === 200, 'the result detail renders once released', `status ${detailAfter.status}`)
  check(
    detailAfter.html.includes(essayStem),
    'the breakdown names the question',
    'the per-question breakdown did not render',
  )
  check(
    detailAfter.html.includes('Between 5 and 63 degrees celsius.'),
    'the breakdown shows what the candidate wrote',
    'the answer is missing from the breakdown',
  )
  check(
    detailAfter.html.includes('Render Chef'),
    'the result names who marked it',
    'the evaluator is not named on the result',
  )
  check(
    detailAfter.html.includes('Render Verifier'),
    'the result names who signed it off',
    'the verifier is not named on the result',
  )
  // The verifier's note is an internal conversation. 0028 kept it away from
  // candidates and the results page must not hand it back.
  check(
    !detailAfter.html.includes('Agreed.'),
    'the verifier note is not shown to the candidate',
    'THE VERIFIER NOTE LEAKED TO THE CANDIDATE',
  )
  // And still no answer key, on the one page that shows a marked paper back.
  for (const forbidden of ['"correct"', '"model_answer"', '"rubric"', '"accept"', rubricLabel]) {
    check(
      !detailAfter.html.includes(forbidden),
      `the result page contains no ${forbidden === rubricLabel ? 'rubric text' : forbidden}`,
      `THE RESULT PAGE LEAKED ${forbidden}`,
    )
  }

  // ── /reports ─────────────────────────────────────────────────────────────
  // The candidate has one released result by now, so this exercises the
  // populated path. The empty path is checked against the verifier, who has
  // sat nothing — and getting THAT wrong is the more damaging failure, because
  // "0% pass rate" tells somebody they failed everything.
  const reports = await candGet('/en/reports')
  check(reports.status === 200, '/en/reports renders', `status ${reports.status} → ${reports.location}`)
  check(
    !/MISSING_MESSAGE|IntlError/.test(reports.html),
    'every message key resolves on reports',
    'a translation key is missing',
  )
  check(
    />Exams taken</.test(reports.html),
    'the summary renders for somebody with results',
    'the reports summary did not render',
  )
  check(
    !/>Nothing to report yet/.test(reports.html),
    'somebody with a result does not see the empty state',
    'a candidate with a released result was told there is nothing to report',
  )

  const emptyReports = await verGet('/en/reports')
  check(
    />Nothing to report yet/.test(emptyReports.html),
    'somebody who has sat nothing sees an empty state',
    'the empty state is missing on reports',
  )
  // The assertion this section exists for: somebody with no attempts gets the
  // empty state INSTEAD OF a summary, so there is no figure to misread as a
  // score of zero.
  //
  // Deliberately not `!/>0%</` over the whole page. Once the team sections
  // render, a legitimate 0% appears there — an exam with one attempt and no
  // passes really does have a zero pass rate — and a page-wide check would
  // call that correct output a leak. Same error as scoping the released-result
  // check to the whole document.
  check(
    !/>Exams taken</.test(emptyReports.html),
    'somebody with no attempts is shown no summary figures at all',
    'a summary was rendered for somebody with no attempts',
  )

  // The team sections, and who may see them. Asserted as a pair against the
  // same string so neither direction can pass vacuously.
  check(
    />The team</.test(emptyReports.html),
    'a chef sees the team section',
    'the team section is missing for a chef',
  )
  check(
    !/>The team</.test(reports.html),
    'a candidate does not see the team section',
    'A CANDIDATE WAS SHOWN THE TEAM REPORT',
  )
  check(
    />Question calibration</.test(emptyReports.html),
    'the question calibration section renders',
    'the question calibration section is missing',
  )
  // The sample-size discipline, visible rather than merely enforced. Every
  // question in this run has one or two responses, so discrimination must be
  // reported as absent rather than as a number.
  check(
    />Not enough responses</.test(emptyReports.html),
    'a thin sample is named rather than left blank',
    'discrimination was shown for a question with too few responses',
  )
  check(
    />Not started</.test(emptyReports.html),
    'somebody who has sat nothing is listed as not started',
    'the not-started state is missing from the team table',
  )

  /*
   * ┌───────────────────────────────────────────────────────────────────────────┐
   * │ THE TRANSLATION WORKBENCH HAS NO PAGE EITHER.                            │
   * │                                                                           │
   * │ /questions/[id]/translations 404s in the rebuilt product — translation is │
   * │ part of the question editor now, and the trilingual delivery it fed is    │
   * │ covered by section 10 below, which sits a whole exam in Gujarati and      │
   * │ reads what the candidate actually receives.                               │
   * │                                                                           │
   * │ The four rendering assertions are gone. The REFUSAL below stays: a route  │
   * │ with no page must still not tell a candidate which editor routes exist.   │
   * └───────────────────────────────────────────────────────────────────────────┘
   */
  const candWorkbench = await candGet(`/en/questions/${questionId}/translations`)
  check(
    candWorkbench.status !== 200,
    'a candidate cannot open the translation workbench',
    `a candidate got ${candWorkbench.status} on the workbench`,
  )

  // ── Locales ──────────────────────────────────────────────────────────────
  // Everything above renders /en. These three locales have partial bundles by
  // design — request.ts merges each over English — so the property to prove is
  // that a translated string appears AND an untranslated one falls back to
  // readable English rather than to a raw key.
  for (const [locale, translated] of [
    ['hi', 'मेरी परीक्षाएँ'],
    ['gu', 'મારી પરીક્ષાઓ'],
  ]) {
    const page = await candGet(`/${locale}/results`)
    check(
      page.status === 200,
      `/${locale}/results renders`,
      `status ${page.status} → ${page.location}`,
    )
    check(
      page.html.includes(translated),
      `${locale} renders its own translation`,
      `${locale} did not render "${translated}" — the bundle is not being applied`,
    )
    // The fallback, and the thing that makes partial translation safe: no raw
    // key ever reaches a candidate.
    check(
      !/MISSING_MESSAGE|IntlError/.test(page.html),
      `${locale} resolves every key, translated or fallen back`,
      `${locale} produced a missing-message error`,
    )
  }

  // ── CSV export ───────────────────────────────────────────────────────────
  // /api sits outside the proxy's matcher, so nothing has checked the session
  // before the handler runs. Its own requirePermission() is the entire gate,
  // which makes the anonymous and candidate cases the ones that matter.
  const exportRes = await fetch(`${APP}/api/reports/export?dataset=team`, {
    headers: { cookie: verCookie },
    redirect: 'manual',
  })
  const exportBody = await exportRes.text()
  check(exportRes.status === 200, 'a chef can export the team CSV', `status ${exportRes.status}`)
  check(
    (exportRes.headers.get('content-type') ?? '').includes('text/csv'),
    'the export is served as CSV',
    `content-type was ${exportRes.headers.get('content-type')}`,
  )
  check(
    (exportRes.headers.get('content-disposition') ?? '').includes('attachment; filename="bookends-team-'),
    'the export downloads with a dated filename',
    `content-disposition was ${exportRes.headers.get('content-disposition')}`,
  )
  check(
    exportBody.startsWith('Name,Exams taken,Passed,Pass rate %,Average %,Last taken'),
    'the CSV carries a header row',
    `CSV began: ${exportBody.slice(0, 60)}`,
  )
  check(
    exportBody.includes('Render Candidate'),
    'the CSV contains the team rows',
    'the exported CSV has no data rows',
  )

  const candExport = await fetch(`${APP}/api/reports/export?dataset=team`, {
    headers: { cookie: candCookie },
    redirect: 'manual',
  })
  check(
    candExport.status === 403,
    'a candidate is refused the export with 403',
    `expected 403 for a candidate, got ${candExport.status}`,
  )

  const anonExport = await fetch(`${APP}/api/reports/export?dataset=team`, { redirect: 'manual' })
  check(
    anonExport.status === 401,
    'an anonymous request is refused the export with 401',
    `expected 401 for an anonymous request, got ${anonExport.status}`,
  )

  // ── 10. A candidate sits a translated exam ───────────────────────────────
  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ THE POINT OF M7. Everything above proves the machinery; this proves a   │
  // │ Gujarati speaker actually reads the question in Gujarati — and that the │
  // │ other languages did not travel with it.                                 │
  // └─────────────────────────────────────────────────────────────────────────┘
  console.log('\n10. Sitting an exam in another language')

  const guStem = `પ્રશ્ન ${stamp}: ભય ક્ષેત્ર શું છે?`
  const guOption = `ચોખાની ભૂકી ${stamp}`

  // Published, because a draft is somebody's working copy: only 'published'
  // reaches a snapshot.
  await db.query(
    `insert into public.question_translations
       (question_id, locale, stem, content, status, translated_by)
     values ($1,'gu',$2,$3::jsonb,'published',$4)
     on conflict (question_id, locale) do update
       set stem = excluded.stem, content = excluded.content, status = 'published'`,
    [questionId, guStem, JSON.stringify({ choices: { b: guOption } }), user.id],
  )

  // A fresh exam, because the snapshot is frozen at publish and the earlier one
  // was frozen before the translation existed — which is itself the behaviour
  // the accepts_stale advisory warns about.
  const { rows: guExam } = await db.query(
    `insert into public.exams
       (company_id, title, created_by, kind, duration_minutes, paper_mode,
        max_attempts, pass_mark_percent, verification_mode, closes_at)
     values ($1,$2,$3,'official',30,'fixed',3,50,'auto', now() + interval '1 day')
     returning id`,
    ['00000000-0000-0000-0000-00000000c001', `Render check gu exam ${stamp}`, user.id],
  )
  const guExamId = guExam[0].id
  createdExams.push(guExamId)

  const { rows: guSection } = await db.query(
    `insert into public.exam_sections (exam_id, title, sort_order)
     values ($1,'Only section',0) returning id`,
    [guExamId],
  )
  await db.query(
    `insert into public.exam_rules
       (section_id, category_id, question_count, difficulty_min, difficulty_max, question_types)
     values ($1,$2,1,1,5,$3::public.question_type[])`,
    [guSection[0].id, RENDER_CAT, ['mcq_single']],
  )
  await db.query(
    `insert into public.exam_assignments (exam_id, target_kind, target_id)
     values ($1,'outlet','00000000-0000-0000-0000-00000000a001')`,
    [guExamId],
  )
  await fetch(`${URL_}/rest/v1/rpc/publish_exam`, {
    method: 'POST',
    headers: {
      apikey: PUB,
      Authorization: `Bearer ${session.access_token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_exam_id: guExamId }),
  })

  // The frozen snapshot must now carry the Gujarati alongside the English.
  const { rows: frozen } = await db.query(
    `select snapshot from public.exam_questions where exam_id = $1 limit 1`,
    [guExamId],
  )
  check(
    Boolean(frozen[0]?.snapshot?.i18n?.gu),
    'publishing freezes the translation into the paper',
    'the frozen snapshot carries no Gujarati',
  )

  await db.query(`update public.profiles set preferred_locale = 'gu' where id = $1`, [candUser.id])

  const guStart = await (await candRpc('start_attempt', { p_exam_id: guExamId })).json()
  const guAttempt = Array.isArray(guStart) ? guStart[0]?.attempt_id : null
  check(Boolean(guAttempt), 'the candidate starts the translated exam', 'start_attempt failed')

  if (guAttempt) {
    const guPaper = await candGet(`/gu/attempt/${guAttempt}`)
    check(guPaper.status === 200, '/gu/attempt/[id] renders', `status ${guPaper.status}`)
    check(
      guPaper.html.includes(guStem),
      'the question is shown in Gujarati',
      'the candidate got the English stem on a Gujarati paper',
    )
    check(
      guPaper.html.includes(guOption),
      'the translated option is shown',
      'the option was not translated',
    )
    // Untranslated strings keep their English rather than going blank — a
    // half-finished translation must read as a mixture, not as gaps.
    check(
      guPaper.html.includes('Rice bran'),
      'an untranslated option falls back to English rather than disappearing',
      'an untranslated option vanished instead of falling back',
    )
    // localise_snapshot strips every other language on the way out. Without
    // this the candidate downloads every translation of every question.
    check(
      !/"i18n"/.test(guPaper.html),
      'no other language travels to the candidate',
      'THE PAPER CARRIED EVERY LANGUAGE TO THE BROWSER',
    )
    for (const forbidden of ['"correct"', '"accept"', '"rubric"']) {
      check(
        !guPaper.html.includes(forbidden),
        `the translated paper contains no ${forbidden}`,
        `THE TRANSLATED PAPER LEAKED ${forbidden}`,
      )
    }
  }

  await db.query(`update public.profiles set preferred_locale = 'en' where id = $1`, [candUser.id])

  // ── The release notice ───────────────────────────────────────────────────
  const { rows: notices } = await db.query(
    `select kind, link from public.notifications where data ->> 'attempt_id' = $1`,
    [essayAttempt],
  )
  check(
    notices.length === 1 && notices[0].kind === 'result.published',
    'publishing notifies the candidate exactly once',
    `expected one result.published notification, found ${notices.length}`,
  )
  check(
    notices[0]?.link === `/results/${essayAttempt}`,
    'the notification links to the result',
    `notification link is ${notices[0]?.link}`,
  )
  const { rows: mails } = await db.query(
    `select template, priority from public.email_outbox where payload ->> 'attempt_id' = $1`,
    [essayAttempt],
  )
  check(
    mails.length === 1 && mails[0].template === 'result-published',
    'publishing queues exactly one email',
    `expected one queued email, found ${mails.length}`,
  )
} catch (e) {
  bad(`render check threw: ${e.message}`)
} finally {
  if (createdExams.length) {
    // Release notices first: email_outbox.to_user_id is ON DELETE SET NULL, so
    // these outlive both the attempt and the candidate unless named directly.
    await db.query(
      `delete from public.email_outbox
        where payload ->> 'attempt_id' in (
          select a.id::text from public.attempts a where a.exam_id = any($1::uuid[]))`,
      [createdExams],
    )
    await db.query(
      `delete from public.notifications
        where data ->> 'attempt_id' in (
          select a.id::text from public.attempts a where a.exam_id = any($1::uuid[]))`,
      [createdExams],
    )
    // Attempts next. attempts.exam_id is ON DELETE RESTRICT by design — a sat
    // paper must not disappear because somebody tidied up the exam — so the
    // exam cannot go until the attempts made against it have.
    await db.query('delete from public.attempts where exam_id = any($1::uuid[])', [createdExams])
    await db.query('delete from public.exams where id = any($1::uuid[])', [createdExams])
  }
  if (createdQuestions.length) {
    await db.query('delete from public.questions where id = any($1::uuid[])', [createdQuestions])
  }
  // After the questions that reference it, and only if nothing else has since
  // been filed under it.
  await db.query(
    `delete from public.categories c
      where c.id = $1
        and not exists (select 1 from public.questions q where q.category_id = c.id)`,
    [RENDER_CAT],
  )
  for (const id of createdUsers) {
    await fetch(`${URL_}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: adminHeaders })
  }
  console.log(
    `\n  🧹 removed ${createdUsers.length} user(s), ${createdQuestions.length} question(s), ${createdExams.length} exam(s)`,
  )
  await db.end()
}

console.log(fail === 0 ? '\nRender check passed.\n' : `\n${fail} check(s) failed.\n`)
process.exit(fail === 0 ? 0 : 1)
