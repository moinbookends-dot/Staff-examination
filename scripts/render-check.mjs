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

/**
 * Is the button whose label is `label` rendered, and is it disabled?
 *
 * Returns true / false / null-if-absent. Written as a lookback from the text
 * node rather than one regex over the whole tag because attribute order is not
 * ours to predict, and because a bare `html.includes('Publish')` matches the
 * next-intl message bundle that every page serialises for the client provider —
 * which is exactly how two earlier assertions in this file passed vacuously.
 */
function buttonIsDisabled(html, label) {
  const textAt = html.indexOf(`>${label}<`)
  if (textAt === -1) return null
  const openAt = html.lastIndexOf('<button', textAt)
  if (openAt === -1) return null

  // The ATTRIBUTE, not the substring. Every button in this app carries Tailwind
  // variant classes containing the word — `disabled:pointer-events-none
  // disabled:opacity-50` — so `.includes('disabled')` reports every button as
  // disabled and any assertion built on it passes vacuously. The `\s` guard
  // also keeps `aria-disabled` from matching.
  return /\sdisabled(=""|\s|>)/.test(html.slice(openAt, textAt))
}

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
     select $1, id from public.roles where key='chef' on conflict do nothing`,
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

  // Asserted as a pair, so neither direction can pass vacuously: the chef acts
  // on the marking queue and sees it; HR cannot and must not.
  check(
    />To mark</.test(dashboard.html),
    'a chef is shown the marking queue',
    'the chef dashboard has no marking queue tile',
  )
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

  // ── The executive overview, and the line between real and not-yet-real ────
  //
  // Both roles reach it through DIFFERENT grants — the chef via
  // reports.read_team, HR via reports.read_all — and both are asserted, because
  // an overview that renders for one and 500s for the other is the exact bug
  // section 1b exists to catch.
  for (const [who, page] of [
    ['a chef', dashboard],
    ['HR', hrDashboard],
  ]) {
    check(
      />Executive overview</.test(page.html),
      `${who} sees the executive overview`,
      `${who} did not get the executive overview`,
    )
    check(
      />Overall pass rate</.test(page.html),
      `${who} sees the headline pass rate`,
      `the hero figure is missing for ${who}`,
    )
  }

  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ THE PANELS WITH NO DATA MUST SAY SO, AND MUST NOT INVENT ANY.           │
  // │                                                                         │
  // │ Four panels in the reference design cannot be answered by this schema —  │
  // │ a weekly time series, period-over-period deltas, a department rollup,    │
  // │ and an audit feed whose RLS policy has no company predicate. Each keeps  │
  // │ its place in the layout behind a "Backend required" label rather than    │
  // │ being filled with numbers that look right.                              │
  // │                                                                         │
  // │ The second assertion is the load-bearing one: it pins the literal        │
  // │ figures from the mock (94.2% pass rate, 88.4% average, 1,284 exams,      │
  // │ +10.8%). If any of them ever appears in the served HTML, somebody has    │
  // │ hard-coded the design's placeholder data into the product — which on a   │
  // │ page a manager uses to decide who needs retraining is worse than an      │
  // │ empty panel, and looks identical to working software.                    │
  // └─────────────────────────────────────────────────────────────────────────┘
  check(
    />Backend required</.test(dashboard.html),
    'panels with no data behind them are labelled rather than faked',
    'the Backend required label is missing',
  )
  check(
    !/94\.2|88\.4|1,284|\+10\.8/.test(dashboard.html),
    'no figure from the design mock is being rendered as real data',
    'A NUMBER FROM THE DESIGN MOCK IS BEING SHOWN AS IF IT WERE REAL',
  )
  // Named explicitly so that "why is there no activity feed?" has an answer in
  // the product, not only in a document nobody opens.
  check(
    /audit_logs_read/.test(dashboard.html),
    'the activity feed states the RLS policy blocking it',
    'the live activity panel does not say what it is blocked on',
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


  // ── 3. The bank ────────────────────────────────────────────────────────────
  console.log('\n2. Question bank')
  const list = await get('/en/questions')
  check(list.status === 200, '/en/questions renders', `status ${list.status} → ${list.location}`)
  check(list.html.includes(stem), 'the question appears in the table', 'the question was not listed')
  // An <option> element, not the word. 'Food Safety' also appears in the
  // serialised message bundle and in seeded question stems, so a bare includes()
  // stays true even if listCategories() returns [] and the filter renders empty.
  check(
    /<option value="[0-9a-f-]{36}"[^>]*>(— )?Food Safety<\/option>/.test(list.html),
    'the category filter is populated with real options',
    'the category filter rendered no category options',
  )
  // next-intl throws on a missing key, so this catches an untranslated string
  // before a chef meets it.
  check(!/MISSING_MESSAGE|IntlError/.test(list.html), 'every message key resolves', 'a translation key is missing')

  // Filters live in the URL, which is the claim that makes them shareable.
  const filtered = await get('/en/questions?status=draft&difficulty=3')
  check(filtered.html.includes(stem), 'a filtered URL renders the matching row', 'the filter URL returned nothing')
  const excluded = await get('/en/questions?status=active')
  check(!excluded.html.includes(stem), 'a filter that excludes it hides the row', 'a draft showed under status=active')
  const searched = await get(`/en/questions?q=${encodeURIComponent('smoke')}`)
  check(searched.html.includes(stem), 'full-text search finds it', 'search returned nothing')

  // ── Bloom and provenance ──────────────────────────────────────────────────
  //
  // Both are columns in the database that reached the page and were thrown
  // away: listQuestions already SELECTed bloom_level, source and imported_from
  // while the table rendered seven columns, none of them these.
  check(
    /<option value="analyze"/.test(list.html) && /<option value="create"/.test(list.html),
    'the Bloom filter is populated from the taxonomy',
    'the Bloom filter rendered no options',
  )
  check(
    /<option value="import"/.test(list.html) && /<option value="ai"/.test(list.html),
    'the provenance filter is populated',
    'the source filter rendered no options',
  )
  // Asserted as a PAIR against the same URL, so neither direction is vacuous:
  // an unknown filter value must drop only itself and leave the rest working.
  // Before parseQuestionFilters, `?status=approved&q=smoke` returned the
  // unfiltered first page — everything discarded, silently, to somebody who
  // believed they were reading a filtered list.
  // 'nonsense', not 'approved' — the first draft of this check used approved,
  // which WAS invalid before 0037 added it to the enum and is now perfectly
  // valid, so the check was quietly asserting that a working filter works.
  const unknownFilter = await get(
    `/en/questions?status=nonsense&q=${encodeURIComponent('smoke')}`,
  )
  check(
    unknownFilter.html.includes(stem),
    'an unrecognised filter value drops only itself, keeping the search term',
    'an unknown status discarded the whole query',
  )
  const realFilter = await get('/en/questions?status=active')
  check(
    !realFilter.html.includes(stem),
    'a filter that genuinely excludes the row still hides it',
    'the filter stopped filtering — the check above proves nothing',
  )

  // ── Sorting, page size, and the recycle bin ───────────────────────────────
  //
  // `?sort=` reaches PostgREST's .order() as a COLUMN NAME, so an unvalidated
  // value is a 400 on every page load from a mistyped bookmark. The allowlist
  // in src/lib/questions/sort.ts is what stops that, and this is the assertion
  // that it is actually wired in rather than merely exported.
  const sorted = await get('/en/questions?sort=difficulty&dir=asc')
  check(sorted.status === 200 && sorted.html.includes(stem), 'the bank sorts by a chosen column', `status ${sorted.status}`)

  const badSort = await get('/en/questions?sort=search_tsv&dir=sideways')
  check(
    badSort.status === 200 && badSort.html.includes(stem),
    'an unusable sort column falls back instead of 500ing',
    `status ${badSort.status} — the sort value reached the database`,
  )

  // The page size becomes a .range(), and one page also drives two batched
  // reads keyed on every id it returned. Unbounded, it is a scan of the bank.
  const hugePage = await get('/en/questions?pageSize=100000')
  check(
    hugePage.status === 200 && hugePage.html.includes(stem),
    'a hand-edited page size falls back to a supported one',
    `status ${hugePage.status}`,
  )
  const realPageSize = await get('/en/questions?pageSize=50')
  check(realPageSize.status === 200, 'an offered page size is accepted', `status ${realPageSize.status}`)

  // The recycle bin holds nothing yet — the question above is very much alive —
  // so this asserts the view opens and does NOT show a live question. Whether a
  // chef may see removed questions at all is 0041's policy, tested in the RLS
  // suite; this only proves the flag is plumbed and does not leak.
  const bin = await get('/en/questions?deleted=1')
  check(bin.status === 200, '/en/questions?deleted=1 renders', `status ${bin.status}`)
  check(
    !bin.html.includes(stem),
    'the recycle bin does not list questions that are still live',
    'a live question appeared under deleted=1',
  )

  // ── The grid ──────────────────────────────────────────────────────────────
  //
  // The columns M8 added to the database and the table never showed. Asserted
  // by their header text, because the values themselves ('—', a date) appear
  // all over the page and would match against a table that renders none of them.
  for (const [label, name] of [
    ['Languages', 'translation coverage'],
    ['Health', 'question health'],
    ['Created by', 'the author'],
    ['Fixed papers', 'the usage counter'],
  ]) {
    check(list.html.includes(`>${label}<`), `the bank shows ${name}`, `no ${label} column`)
  }

  // The seeded question has a category and an answer key but no Bloom level and
  // no published translations, so exactly two flags are expected. Asserted as a
  // PAIR: the present ones prove badges render, the absent ones prove the rule
  // discriminates rather than badging everything.
  //
  // MATCHED ON data-health, NOT ON THE LABEL. next-intl serialises the entire
  // message bundle into the page, so `includes('No answer key')` is true
  // whether or not a badge rendered — exactly the failure this file already
  // records for 'Food Safety'. Both negatives below passed against the label
  // and failed against the markup, which is how the trap was found.
  check(
    /data-health="no-bloom"/.test(list.html),
    'a question with no Bloom level is flagged',
    'the health column flagged nothing',
  )
  check(
    /data-health="untranslated"/.test(list.html),
    'a question with no published translation is flagged',
    'the translation flag never fires',
  )
  check(
    !/data-health="no-answer-key"/.test(list.html),
    'a question WITH an answer key is not flagged as missing one',
    'the health column flags every question — the badge means nothing',
  )
  check(
    !/data-health="no-category"/.test(list.html),
    'a categorised question is not flagged as uncategorised',
    'the category flag fires regardless of the category',
  )

  // Selection is what the whole bulk toolbar hangs off. The toolbar itself only
  // renders once something is selected, so it cannot appear in server HTML —
  // the checkbox is the thing to assert.
  check(
    /aria-label="Select every question on this page"/.test(list.html),
    'a chef is offered row selection',
    'the select-all checkbox is missing, so nothing can be selected',
  )
  // Sortable headers are buttons, not links: sorting uses router.replace so
  // that sorting four times does not cost four presses of Back.
  check(
    list.html.includes('Sorted A to Z. Choose again to reverse.') ||
      list.html.includes('Sorted Z to A. Choose again to reverse.'),
    'the sorted column says so in words, not only with an icon',
    'the sort state is conveyed by the arrow icon alone',
  )
  check(
    list.html.includes('Saved filters'),
    'saved filters are offered',
    'the saved-filter control is missing',
  )

  // ── Guide (AI) ─────────────────────────────────────────────────────────────
  //
  // The document library (0048, kinds widened by 0050). Asserted BEFORE the nav
  // entry exists, and that ordering is the point: /learning and /admin sat in
  // the sidebar since M2 with no page behind them, and the fix for that landed
  // in the same session as this page. A route earns its nav item by rendering.
  const guide = await get('/en/guide')
  check(guide.status === 200, '/en/guide renders', `status ${guide.status} → ${guide.location}`)
  check(
    !/MISSING_MESSAGE|IntlError/.test(guide.html),
    'every message key resolves on Guide (AI)',
    'a translation key is missing',
  )
  // The tabs are anchors, not client state, so a filtered shelf is shareable and
  // needs no JavaScript. Asserted as hrefs rather than by label text, because
  // next-intl serialises the whole message bundle into the page — the trap this
  // file already records for 'Food Safety' and again for the health badges.
  check(
    /href="[^"]*\/guide\?[^"]*kind=cookbooks/.test(guide.html),
    'the document-type tabs are real links',
    'the tab strip is not navigable without JavaScript',
  )
  // An unknown tab must fall back rather than 500, exactly as an unknown
  // question filter does. These arrive from URLs people edit and share.
  const badTab = await get('/en/guide?kind=nonsense')
  check(
    badTab.status === 200,
    'an unrecognised document tab falls back instead of erroring',
    `status ${badTab.status}`,
  )
  // A candidate holds no questions.read. Source documents are the material the
  // questions are drawn from; they have no business reading the library.
  // (candGet is defined further down, so the refusal is asserted there.)

  // ── 4. The editor ──────────────────────────────────────────────────────────
  console.log('\n3. Editor')
  const create = await get('/en/questions/new')
  check(create.status === 200, '/en/questions/new renders', `status ${create.status} → ${create.location}`)
  // Again as options: the type <select> must actually have children.
  check(
    (create.html.match(/<option value="(mcq_single|essay|true_false)"/g) ?? []).length >= 3,
    'the question type select is populated',
    'the question type select rendered no options',
  )
  check(!/MISSING_MESSAGE|IntlError/.test(create.html), 'every message key resolves', 'a translation key is missing')

  if (questionId) {
    const edit = await get(`/en/questions/${questionId}`)
    check(edit.status === 200, '/en/questions/[id] renders', `status ${edit.status} → ${edit.location}`)
    check(edit.html.includes(stem), 'the stored stem populates the editor', 'the stem did not render')
    check(edit.html.includes('Rice bran'), 'the stored options reach the format editor', 'options did not render')
    check(
      edit.html.includes('seeded by the render check'),
      'the History tab shows the change note',
      'the change note is missing from history',
    )
  }

  const missing = await get('/en/questions/00000000-0000-0000-0000-0000000000ff')
  check(missing.status === 404, 'an unknown question 404s', `status ${missing.status}`)

  // ── 4. Exams ───────────────────────────────────────────────────────────────
  console.log('\n4. Exams')

  // ACTIVATED HERE, not at seed time. save_question() creates drafts and
  // draw_paper() only ever selects status='active' — a draft is not eligible
  // for an exam, by design — so the exam checks below need an active question.
  // Doing it earlier would break the question-bank filter assertions above,
  // which deliberately exercise a DRAFT.
  if (questionId) {
    await db.query(`update public.questions set status='active' where id=$1`, [questionId])
  }

  const examList = await get('/en/exams')
  check(examList.status === 200, '/en/exams renders', `status ${examList.status} → ${examList.location}`)
  check(
    !/MISSING_MESSAGE|IntlError/.test(examList.html),
    'every message key resolves on the exam list',
    'a translation key is missing',
  )

  const newExam = await get('/en/exams/new')
  check(newExam.status === 200, '/en/exams/new renders', `status ${newExam.status} → ${newExam.location}`)
  // The old check looked for 'Food Safety' — which this page never renders.
  // It only ever matched the message bundle, so it would have passed against a
  // blank page. Assert the form's actual inputs instead.
  check(
    newExam.html.includes('id="exam-title"') &&
      newExam.html.includes('id="exam-kind"') &&
      newExam.html.includes('id="exam-duration"'),
    'the settings form renders its inputs',
    'the settings form inputs are missing',
  )
  check(
    !/MISSING_MESSAGE|IntlError/.test(newExam.html),
    'every message key resolves in the exam form',
    'a translation key is missing',
  )

  // Create one through the real action path, then read it back on the list.
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

  const listWithExam = await get('/en/exams')
  check(listWithExam.html.includes(examTitle), 'a draft exam appears in the list', 'the exam was not listed')

  // Empty state FIRST, before any section exists — and matched as a text node.
  // `includes('No sections yet')` would pass either way, because next-intl
  // serialises the whole message bundle into the page for the client provider.
  const emptyDetail = await get(`/en/exams/${examId}`)
  check(
    />No sections yet/.test(emptyDetail.html),
    'a sectionless exam shows the empty state',
    'the empty section state is missing',
  )

  // A section with two rules over the SAME category, so the second is starved
  // by the first — the case the two-number display exists for.
  const { rows: sectionRows } = await db.query(
    `insert into public.exam_sections (exam_id, title, sort_order)
     values ($1,'Render check section',0) returning id`,
    [examId],
  )
  await db.query(
    `insert into public.exam_rules (section_id, category_id, question_count, difficulty_min, difficulty_max, sort_order)
     values ($1,$2,3,1,5,0), ($1,$2,3,1,5,1)`,
    [sectionRows[0].id, RENDER_CAT],
  )

  const withSections = await get(`/en/exams/${examId}`)
  check(
    withSections.html.includes('Render check section'),
    'the section builder renders a saved section',
    'the section did not render',
  )
  check(
    withSections.html.includes('1 match this rule'),
    'each rule shows a real match count',
    'the live rule count is missing or zero',
  )

  const examDetail = await get(`/en/exams/${examId}`)
  check(examDetail.status === 200, '/en/exams/[id] renders', `status ${examDetail.status}`)
  check(examDetail.html.includes(examTitle), 'the exam detail shows its title', 'title missing')
  check(
    !/>No sections yet/.test(examDetail.html),
    'the empty state disappears once a section exists',
    'the empty state is still shown for an exam that has sections',
  )

  // NOTE THE `>text<` FORM. next-intl serialises the whole message bundle into
  // the page for the client provider, so a bare `includes('Save settings')`
  // matches the JSON blob and is true whether or not the button rendered.
  // Matching the text node asserts on what was actually drawn.
  const savedButton = />Save settings</
  check(
    savedButton.test(examDetail.html),
    'a draft exam offers its save button',
    'the save button is missing from a draft',
  )

  // ── Schedule, assignments and clone ───────────────────────────────────────
  console.log('\n5. Schedule and assignments')

  check(
    withSections.html.includes('id="exam-opens"') && withSections.html.includes('id="exam-closes"'),
    'a draft offers both ends of the window',
    'the schedule inputs are missing from a draft',
  )
  check(
    withSections.html.includes('id="exam-timezone"'),
    'a draft offers the timezone',
    'the timezone control is missing',
  )
  check(
    />Nobody is assigned yet/.test(withSections.html),
    'an unassigned exam says so',
    'the empty assignment state is missing',
  )
  check(
    buttonIsDisabled(withSections.html, 'Duplicate') === false,
    'the duplicate button is offered',
    'the duplicate button is missing or disabled',
  )

  // Assign it, and confirm the badge names the outlet rather than a raw uuid.
  await db.query(
    `insert into public.exam_assignments (exam_id, target_kind, target_id)
     values ($1,'outlet','00000000-0000-0000-0000-00000000a001')`,
    [examId],
  )
  const assigned = await get(`/en/exams/${examId}`)
  check(
    assigned.html.includes('Aiko — Outlet 1'),
    'an assignment renders with its outlet name',
    'the assignment badge is missing or shows a raw id',
  )
  check(
    !/>Nobody is assigned yet/.test(assigned.html),
    'the empty assignment state disappears once assigned',
    'the empty state is still shown for an assigned exam',
  )

  // ── Exam Health ────────────────────────────────────────────────────────────
  // The two rules above each want 3 questions from Food Safety, and the bank
  // holds exactly the one this script seeded. So the paper is short and the
  // panel must say so rather than letting publish fail later.
  console.log('\n6. Exam Health')

  check(/>Exam health</.test(withSections.html), 'the health panel renders', 'the health panel is missing')
  check(
    withSections.html.includes('the bank could supply'),
    'a rule that cannot be satisfied is reported',
    'rule.short was not surfaced',
  )
  check(
    withSections.html.includes('Widen the rule'),
    'a blocking issue carries its remedy',
    'the remedy text is missing',
  )
  check(
    />Some things must be fixed/.test(withSections.html),
    'the panel says the exam is not ready',
    'the not-ready description is missing',
  )
  check(
    buttonIsDisabled(withSections.html, 'Publish') === true,
    'the publish button is disabled while blocked',
    'a blocked exam still offers an enabled Publish button',
  )

  // ── M9: the quality dashboard ─────────────────────────────────────────────
  //
  // Every number on it is a query. The assertions below are about the SHAPE of
  // the page rather than the figures, because the figures depend on how much
  // attempt data happens to exist — and a check that only passes on a bank with
  // ten answers per question is one that gets deleted the first time it fails.
  const quality = await get('/en/questions/quality')
  check(quality.status === 200, '/en/questions/quality renders', `status ${quality.status} → ${quality.location}`)
  check(
    !/MISSING_MESSAGE|IntlError/.test(quality.html),
    'every message key resolves on the quality dashboard',
    'a translation key is missing',
  )
  // Coverage before findings. "2 need attention" means something very
  // different when 6 of 400 questions have ever been measured, and the
  // denominator being present is what stops the page misleading.
  check(
    quality.html.includes('Measured') && /\d+ \/ \d+/.test(quality.html),
    'the dashboard states how much of the bank has been measured',
    'the coverage figure is missing, so the findings have no denominator',
  )
  for (const [label, what] of [
    ['Bloom level', 'the Bloom distribution'],
    ['Difficulty', 'the difficulty distribution'],
    ['Category', 'the category distribution'],
  ]) {
    check(quality.html.includes(`>${label}<`), `the dashboard shows ${what}`, `no ${label} panel`)
  }
  // bank_recommendations returns exam_health's exact shape so ONE component and
  // ONE remedy map render both. The seeded bank has no Bloom levels, so that
  // advisory fires and brings its remedy with it — which is the assertion that
  // the sharing actually happened rather than being claimed in a comment.
  check(
    quality.html.includes('no Bloom level'),
    'a bank-wide advisory is surfaced',
    'bank_recommendations produced nothing on a bank with no Bloom levels',
  )
  check(
    quality.html.includes('so papers can be balanced for cognitive demand'),
    'a bank advisory carries its remedy, from the same map exam health uses',
    'the shared remedy map is not reaching the bank dashboard',
  )
  // The candidate is refused it too — asserted further down, where candGet is
  // in scope.

  // Loosen the rules so the paper can actually be drawn, then re-read.
  await db.query(
    `update public.exam_rules set question_count = 1
      where section_id = $1`,
    [sectionRows[0].id],
  )
  await db.query(`delete from public.exam_rules where section_id = $1 and sort_order = 1`, [
    sectionRows[0].id,
  ])

  const healthy = await get(`/en/exams/${examId}`)
  check(
    />This exam is ready to publish/.test(healthy.html),
    'a satisfiable exam reports ready',
    'the ready state was not reported',
  )
  // The other half of the disabled assertion above. Asserting only that a
  // blocked exam disables Publish would pass even if the button were ALWAYS
  // disabled — which is exactly what the old substring-based helper did.
  check(
    buttonIsDisabled(healthy.html, 'Publish') === false,
    'the publish button is enabled once the exam is ready',
    'Publish is still disabled for a healthy exam',
  )
  check(
    !healthy.html.includes('the bank could supply'),
    'the shortfall disappears once the rule fits',
    'rule.short is still reported for a satisfiable rule',
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

  const lockedDetail = await get(`/en/exams/${examId}`)
  check(
    // The notice is rendered inside a <p>; the same sentence is in the message
    // bundle, so match the element rather than the string.
    />This exam is published/.test(lockedDetail.html),
    'a published exam shows the immutability notice',
    'the locked notice is missing from a published exam',
  )
  check(
    !savedButton.test(lockedDetail.html),
    'a published exam hides its save button',
    'a published exam still offers Save, which the database would refuse',
  )

  // The schedule asymmetry, on the page. 0016 permits closes_at to move after
  // publish and nothing else, so the opening time must stop being an input —
  // not merely be disabled, which still reads as "temporarily unavailable".
  check(
    !lockedDetail.html.includes('id="exam-opens"'),
    'a published exam stops offering the opening time',
    'a published exam still renders an opens_at input the database would refuse',
  )
  check(
    lockedDetail.html.includes('id="exam-closes"'),
    'a published exam still offers the closing time',
    'the closing time is not editable on a published exam',
  )
  check(
    !lockedDetail.html.includes('id="exam-timezone"'),
    'a published exam stops offering the timezone',
    'a published exam still renders a timezone control',
  )
  // Assignments outlive the lock — the paper is fixed, the audience is not.
  check(
    buttonIsDisabled(lockedDetail.html, 'Save assignments') === false,
    'a published exam can still be reassigned',
    'assignments were locked along with the paper',
  )

  // ── 7. Paper preview and provenance ───────────────────────────────────────
  console.log('\n7. Paper and provenance')

  check(
    lockedDetail.html.includes(stem),
    'the frozen paper renders the question a candidate will see',
    'the paper preview did not render the question',
  )
  check(
    lockedDetail.html.includes('Rice bran'),
    'the candidate-facing renderer is mounted, options and all',
    'the question options did not render in the paper',
  )
  check(
    /rev <!-- -->1|>rev 1</.test(lockedDetail.html),
    'each question carries the revision that was frozen',
    'the per-question revision is missing',
  )
  check(
    // 'Published' alone is always true — four message keys contain it. The
    // publisher's NAME is the part only a real render can produce.
    /Published [^<]*by <!-- -->Render Chef|>Published [^<]*by Render Chef/.test(lockedDetail.html) ||
      (lockedDetail.html.includes('Render Chef') &&
        />Published/.test(lockedDetail.html)),
    'the header names who published it and when',
    'publisher provenance is missing',
  )
  // The one thing a paper must never contain.
  for (const forbidden of ['"correct"', 'modelAnswer', '"rubric"']) {
    check(
      !lockedDetail.html.includes(forbidden),
      `the rendered paper contains no ${forbidden}`,
      `THE PAPER LEAKED ${forbidden} TO THE BROWSER`,
    )
  }

  const missingExam = await get('/en/exams/00000000-0000-0000-0000-0000000000ff')
  check(missingExam.status === 404, 'an unknown exam 404s', `status ${missingExam.status}`)

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

  // Guide (AI) holds the cookbooks every question is drawn from. A candidate
  // holds no questions.read and must be turned away by the page guard.
  const candGuide = await candGet('/en/guide')
  check(
    candGuide.status !== 200,
    'a candidate cannot open the Guide (AI) library',
    `a candidate got ${candGuide.status} from /guide`,
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
    for (const forbidden of ['"correct"', 'modelAnswer', '"rubric"', '"accept"']) {
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

  // The authoring list must stay closed to them, or the separation of the two
  // sides is cosmetic.
  const candExams = await candGet('/en/exams')
  check(
    candExams.status !== 200,
    'a candidate cannot open the authoring exam list',
    `a candidate got ${candExams.status} on /en/exams`,
  )

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
     select $1, id from public.roles where key='chef' on conflict do nothing`,
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
  // The verdict pair, asserted in the direction that was broken. The candidate
  // passed the essay exam, so 'Passed' must be here — and the fail branch is
  // covered by the raw-key sweep above, which is what actually failed.
  check(
    />Passed</.test(candDashboard.html),
    'the dashboard shows the verdict on a released result',
    'the released verdict is missing from the dashboard',
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
  for (const forbidden of ['"correct"', 'modelAnswer', '"rubric"', '"accept"', rubricLabel]) {
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

  // ── Translation workbench ────────────────────────────────────────────────
  // The chef holds questions.translate, so this exercises the editable path.
  // The candidate does not hold questions.read, so it must not open at all.
  const workbench = await get(`/en/questions/${questionId}/translations`)
  check(
    workbench.status === 200,
    '/en/questions/[id]/translations renders',
    `status ${workbench.status} → ${workbench.location}`,
  )
  check(
    !/MISSING_MESSAGE|IntlError/.test(workbench.html),
    'every message key resolves on the workbench',
    'a translation key is missing',
  )
  check(
    workbench.html.includes(stem),
    'the workbench shows the English source',
    'the source question did not render',
  )
  check(
    workbench.html.includes('Rice bran'),
    'the workbench lists the strings to translate',
    'the option strings are missing from the workbench',
  )
  // There is no answer key on this surface by construction, and that is worth
  // asserting rather than assuming: a translator who could see the key could
  // be told which option to make attractive.
  for (const forbidden of ['"correct"', '"accept"', '"rubric"']) {
    check(
      !workbench.html.includes(forbidden),
      `the workbench contains no ${forbidden}`,
      `THE TRANSLATION WORKBENCH LEAKED ${forbidden}`,
    )
  }

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
