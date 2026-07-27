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

try {
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
        p_category_id: '00000000-0000-0000-0000-00000000f001',
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
  check(list.html.includes('Food Safety'), 'seeded categories reach the filter', 'the category filter is empty')
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

  // ── 4. The editor ──────────────────────────────────────────────────────────
  console.log('\n3. Editor')
  const create = await get('/en/questions/new')
  check(create.status === 200, '/en/questions/new renders', `status ${create.status} → ${create.location}`)
  check(create.html.includes('Multiple choice'), 'question types are translated', 'type labels are missing')
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

  // ── 5. Exams ───────────────────────────────────────────────────────────────
  console.log('\n4. Exams')

  const examList = await get('/en/exams')
  check(examList.status === 200, '/en/exams renders', `status ${examList.status} → ${examList.location}`)
  check(
    !/MISSING_MESSAGE|IntlError/.test(examList.html),
    'every message key resolves on the exam list',
    'a translation key is missing',
  )

  const newExam = await get('/en/exams/new')
  check(newExam.status === 200, '/en/exams/new renders', `status ${newExam.status} → ${newExam.location}`)
  check(newExam.html.includes('Food Safety'), 'the settings form renders its fields', 'form fields missing')
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

  const examDetail = await get(`/en/exams/${examId}`)
  check(examDetail.status === 200, '/en/exams/[id] renders', `status ${examDetail.status}`)
  check(examDetail.html.includes(examTitle), 'the exam detail shows its title', 'title missing')
  check(
    examDetail.html.includes('No sections yet'),
    'the empty section state is shown',
    'section placeholder missing',
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

  // Publishing locks content — the page must say so rather than offering
  // fields the database will refuse.
  await db.query(
    `update public.exams set status='scheduled', published_at=now(), question_count=1, total_marks=2
      where id=$1`,
    [examId],
  )
  const lockedDetail = await get(`/en/exams/${examId}`)
  check(
    lockedDetail.html.includes('This exam is published'),
    'a published exam shows the immutability notice',
    'the locked notice is missing from a published exam',
  )
  check(
    !savedButton.test(lockedDetail.html),
    'a published exam hides its save button',
    'a published exam still offers Save, which the database would refuse',
  )

  const missingExam = await get('/en/exams/00000000-0000-0000-0000-0000000000ff')
  check(missingExam.status === 404, 'an unknown exam 404s', `status ${missingExam.status}`)
} catch (e) {
  bad(`render check threw: ${e.message}`)
} finally {
  if (createdExams.length) {
    await db.query('delete from public.exams where id = any($1::uuid[])', [createdExams])
  }
  if (createdQuestions.length) {
    await db.query('delete from public.questions where id = any($1::uuid[])', [createdQuestions])
  }
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
