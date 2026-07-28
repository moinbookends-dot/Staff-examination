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
      held.html.includes('has not been released'),
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
} catch (e) {
  bad(`render check threw: ${e.message}`)
} finally {
  if (createdExams.length) {
    // Attempts first. attempts.exam_id is ON DELETE RESTRICT by design — a sat
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
