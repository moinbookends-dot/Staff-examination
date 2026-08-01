/**
 * End-to-end walkthrough: register → approve → sign in → read data.
 *
 * Exercises the real HTTP path with real tokens — the same requests a browser
 * makes — rather than talking to Postgres directly. That distinction matters:
 * the pg-level RLS tests fabricate the `app` claim, so they cannot catch a
 * misconfigured auth hook. This can.
 *
 * Covers plan §15 acceptance items 1–2 and the JWT staleness handshake.
 *
 *   node scripts/walkthrough.mjs
 *
 * Creates two temporary users and deletes them at the end.
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
    if (m) out[m[1]] = m[2]
  }
  return out
}

const env = readEnvLocal()
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL
const PUB = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
const SECRET = env.SUPABASE_SECRET_KEY
const ref = new (globalThis.URL)(URL_).hostname.split('.')[0]

let fail = 0
const ok = (m) => console.log(`  ✅ ${m}`)
const bad = (m) => { console.log(`  ❌ ${m}`); fail++ }
const check = (c, good, notGood) => { if (c) ok(good); else bad(notGood) }

const adminHeaders = { apikey: SECRET, Authorization: `Bearer ${SECRET}`, 'Content-Type': 'application/json' }
const stamp = Date.now()
const PASSWORD = 'walkthrough-password-1'

const db = new Client({
  host: process.env.SUPABASE_DB_HOST ?? 'aws-0-ap-southeast-1.pooler.supabase.com',
  port: 5432,
  user: `postgres.${ref}`,
  password: env.SUPABASE_DB_PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
})
await db.connect()

const created = []
const createdQuestions = []

async function createUser(label) {
  const email = `wt-${label}-${stamp}@bookends-test.local`
  const res = await fetch(`${URL_}/auth/v1/admin/users`, {
    method: 'POST',
    headers: adminHeaders,
    body: JSON.stringify({
      email,
      password: PASSWORD,
      email_confirm: true,
      user_metadata: { full_name: `WT ${label}`, locale: 'en' },
    }),
  })
  if (!res.ok) throw new Error(`create ${label}: ${res.status} ${await res.text()}`)
  const u = await res.json()
  created.push(u.id)
  return { id: u.id, email }
}

async function signIn(email) {
  const res = await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: PUB, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
  if (!res.ok) throw new Error(`signin: ${res.status} ${await res.text()}`)
  return res.json()
}

function claimsOf(token) {
  return JSON.parse(
    Buffer.from(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString(),
  )
}

/** Query PostgREST exactly as the browser client would. */
async function asUser(token, path) {
  const res = await fetch(`${URL_}/rest/v1/${path}`, {
    headers: { apikey: PUB, Authorization: `Bearer ${token}` },
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

/** Call an RPC the way supabase-js does from a server action. */
async function rpc(token, name, args) {
  const res = await fetch(`${URL_}/rest/v1/rpc/${name}`, {
    method: 'POST',
    headers: { apikey: PUB, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

try {
  // ── 1. Registration ────────────────────────────────────────────────────────
  console.log('\n1. Registration')
  const emp = await createUser('employee')
  ok(`registered ${emp.email}`)

  let empSession = await signIn(emp.email)
  let app = claimsOf(empSession.access_token).app
  check(app.approved === false, 'new account is unapproved in its token', 'new account already approved')

  // ── 2. Pending users are walled off ────────────────────────────────────────
  console.log('\n2. Pending user access')

  const outletsBefore = await asUser(empSession.access_token, 'outlets?select=id,name')
  check(
    Array.isArray(outletsBefore.body) && outletsBefore.body.length === 0,
    'pending user sees zero outlets (is_approved gate holds)',
    `pending user saw ${JSON.stringify(outletsBefore.body)?.slice(0, 120)}`,
  )

  const ownProfile = await asUser(empSession.access_token, `profiles?select=id,approval_status&id=eq.${emp.id}`)
  check(
    Array.isArray(ownProfile.body) && ownProfile.body.length === 1,
    'pending user CAN read own profile (deliberate exception)',
    'pending user cannot read own profile — /pending screen would break',
  )

  const others = await asUser(empSession.access_token, 'profiles?select=id')
  check(
    Array.isArray(others.body) && others.body.length === 1,
    'pending user sees only their own profile row',
    `pending user saw ${others.body?.length} profile rows`,
  )

  // ── 3. Chef approves ───────────────────────────────────────────────────────
  console.log('\n3. Chef approval')
  const chef = await createUser('chef')
  await db.query(
    `update public.profiles set approval_status='approved', outlet_id=$2 where id=$1`,
    [chef.id, '00000000-0000-0000-0000-00000000a001'],
  )
  await db.query(
    `insert into public.user_roles (user_id, role_id)
     select $1, id from public.roles where key='chef' on conflict do nothing`,
    [chef.id],
  )
  await db.query(`delete from public.user_roles where user_id=$1 and role_id=(select id from public.roles where key='employee')`, [chef.id])

  const chefSession = await signIn(chef.email)
  const chefApp = claimsOf(chefSession.access_token).app
  check(chefApp.roles.includes('chef'), 'chef role present in chef token', `chef roles = ${JSON.stringify(chefApp.roles)}`)
  check(chefApp.perms.includes('users.approve'), 'chef holds users.approve', 'chef missing users.approve')

  // The chef should see the pending employee via profiles_read_team.
  const queue = await asUser(chefSession.access_token, 'profiles?select=id,full_name&approval_status=eq.pending')
  check(
    Array.isArray(queue.body) && queue.body.some((p) => p.id === emp.id),
    'chef sees the pending registration in their queue',
    `chef queue did not contain the applicant: ${JSON.stringify(queue.body)?.slice(0, 150)}`,
  )

  // Approve, as the action does.
  await db.query(
    `update public.profiles
        set approval_status='approved', approved_by=$2, approved_at=now(),
            outlet_id=$3, department_id=(select id from public.departments where slug='kitchen' limit 1)
      where id=$1 and approval_status='pending'`,
    [emp.id, chef.id, '00000000-0000-0000-0000-00000000a001'],
  )
  ok('approved with outlet + department assigned')

  // ── 4. The staleness handshake ─────────────────────────────────────────────
  console.log('\n4. JWT staleness')

  const stale = claimsOf(empSession.access_token).app
  check(
    stale.approved === false,
    'OLD token still says approved:false (this is why /pending polls)',
    'old token already reflects approval — unexpected',
  )

  // NOTE: me_status() cannot be exercised from here — it is scoped to
  // auth.uid() and this is a service-role connection with no user. The /pending
  // screen covers it, and tests/integration exercises it under a real claim.

  const refreshed = await fetch(`${URL_}/auth/v1/token?grant_type=refresh_token`, {
    method: 'POST',
    headers: { apikey: PUB, 'Content-Type': 'application/json' },
    body: JSON.stringify({ refresh_token: empSession.refresh_token }),
  })
  const refreshedSession = await refreshed.json()
  const fresh = claimsOf(refreshedSession.access_token).app

  check(fresh.approved === true, 'REFRESHED token says approved:true', `refresh did not flip approval: ${JSON.stringify(fresh)}`)
  check(fresh.outlet_id === '00000000-0000-0000-0000-00000000a001', 'outlet present in refreshed claims', `outlet_id = ${fresh.outlet_id}`)
  check(Boolean(fresh.department_id), 'department present in refreshed claims', 'department_id missing')
  // TIER 2, and the only place it can be checked: the RLS suite fabricates the
  // `app` claim, so it cannot prove the hook mints one. Until 0023 the hook
  // copied profiles.brand_id — a column nothing writes — so this was null for
  // every user, and brand-targeted exams notified people who then could not see
  // them. It is now derived from the outlet.
  check(
    Boolean(fresh.brand_id),
    'brand present in refreshed claims — derived from the outlet',
    'brand_id is null in a real token: brand-scoped exams and assignments will be invisible',
  )

  // ── 5. Approved access ─────────────────────────────────────────────────────
  console.log('\n5. Approved user access')

  const outletsAfter = await asUser(refreshedSession.access_token, 'outlets?select=id,name')
  check(
    Array.isArray(outletsAfter.body) && outletsAfter.body.length === 3,
    `approved user sees all 3 outlets`,
    `approved user saw ${outletsAfter.body?.length} outlets`,
  )

  const depts = await asUser(refreshedSession.access_token, 'departments?select=id,name')
  check(Array.isArray(depts.body) && depts.body.length === 5, 'approved user sees 5 departments', `saw ${depts.body?.length}`)

  // Still must not read colleagues.
  const colleague = await asUser(refreshedSession.access_token, `profiles?select=id&id=eq.${chef.id}`)
  check(
    Array.isArray(colleague.body) && colleague.body.length === 0,
    'employee still cannot read a colleague’s profile',
    'employee can read another profile — policy too permissive',
  )

  // Audit log must be invisible.
  const audit = await asUser(refreshedSession.access_token, 'audit_logs?select=id')
  check(
    !Array.isArray(audit.body) || audit.body.length === 0,
    'employee cannot read the audit log',
    'employee can read audit_logs',
  )

  // ── 6. Audit trail recorded the approval ───────────────────────────────────
  console.log('\n6. Audit trail')
  const { rows: auditRows } = await db.query(
    `select changes from public.audit_logs
      where table_name='profiles' and record_id=$1 and action='update'
      order by occurred_at desc limit 1`,
    [emp.id],
  )
  check(auditRows.length === 1, 'approval was audit-logged', 'no audit row for the approval')
  if (auditRows.length) {
    check(
      'approval_status' in auditRows[0].changes,
      'audit records the approval_status change',
      `audit changes = ${JSON.stringify(auditRows[0].changes).slice(0, 150)}`,
    )
    check(
      !('email' in auditRows[0].changes),
      'audit stores a diff, not the whole row',
      'audit stored unchanged columns — storage budget at risk',
    )
  }
  // ── 7. The question bank ───────────────────────────────────────────────────
  //
  // WHY THIS IS HERE AND NOT ONLY IN tests/integration: those tests talk to
  // Postgres directly and FABRICATE the app claim, so they cannot see a broken
  // PostgREST grant, a function signature PostgREST refuses to resolve, or an
  // auth hook that stops minting perms. save_question() is the editor's only
  // write path and it is reached exactly like this — POST /rest/v1/rpc/… with a
  // real token. If it 404s here, every RLS test still passes and the editor is
  // dead on arrival.
  console.log('\n7. Question bank')

  const questionContent = {
    format: 'choice_single',
    choices: [
      { id: 'a', text: '63°C' },
      { id: 'b', text: '74°C' },
    ],
  }

  const saved = await rpc(chefSession.access_token, 'save_question', {
    p_id: null,
    p_type: 'mcq_single',
    p_response_format: 'choice_single',
    p_stem: `Walkthrough ${stamp}: minimum safe internal temperature for chicken?`,
    p_content: questionContent,
    p_answer_key: { format: 'choice_single', correct: 'b' },
    p_change_note: 'created by the walkthrough',
    // Provenance and Bloom, set at creation the way an importer would.
    p_source: 'import',
    p_imported_from: 'walkthrough',
    p_bloom_level: 'remember',
  })
  check(
    saved.status === 200 && Array.isArray(saved.body) && saved.body.length === 1,
    'chef creates a question through save_question over HTTP',
    `save_question returned ${saved.status}: ${JSON.stringify(saved.body)?.slice(0, 200)}`,
  )

  const questionId = saved.body?.[0]?.id
  if (questionId) {
    createdQuestions.push(questionId)
    check(saved.body[0].revision === 1, 'new question starts at revision 1', `revision = ${saved.body[0].revision}`)
    check(saved.body[0].status === 'draft', 'new question starts as a draft', `status = ${saved.body[0].status}`)

    const key = await asUser(chefSession.access_token, `question_answer_keys?select=answer_key&question_id=eq.${questionId}`)
    check(
      key.body?.[0]?.answer_key?.correct === 'b',
      'answer key landed in the same call as the question',
      `chef read back ${JSON.stringify(key.body)?.slice(0, 120)}`,
    )

    // ── Provenance, over real HTTP ─────────────────────────────────────────
    //
    // The RLS suite proves the coalesce in save_question. This proves the same
    // thing through PostgREST with a real token, which is the path the importer
    // (M11) and the AI generator (M12) will actually use — a named-argument RPC
    // where a missing parameter takes its default rather than being sent as
    // null. If those two ever disagree, this is where it shows.
    const meta = await asUser(
      chefSession.access_token,
      `questions?select=source,imported_from,bloom_level&id=eq.${questionId}`,
    )
    check(
      meta.body?.[0]?.source === 'import' && meta.body?.[0]?.imported_from === 'walkthrough',
      'provenance is recorded at creation',
      `source/imported_from came back as ${JSON.stringify(meta.body?.[0])}`,
    )
    check(
      meta.body?.[0]?.bloom_level === 'remember',
      'the Bloom level round-trips through the RPC',
      `bloom_level = ${JSON.stringify(meta.body?.[0]?.bloom_level)}`,
    )

    // The change note only exists because 0013 routes it through a
    // transaction-local GUC. Over HTTP each request is its own transaction, so
    // this also proves the GUC survives the trigger and nothing else.
    const { rows: history } = await db.query(
      'select revision, change_note from public.question_revisions where question_id = $1 order by revision',
      [questionId],
    )
    check(history.length === 1, 'revision 1 is in the history table', `history had ${history.length} rows`)
    check(
      history[0]?.change_note === 'created by the walkthrough',
      'the change note reached question_revisions',
      `change_note = ${JSON.stringify(history[0]?.change_note)}`,
    )

    // ── The leak test, over real HTTP with a real employee token ────────────
    const empKey = await asUser(refreshedSession.access_token, `question_answer_keys?select=answer_key&question_id=eq.${questionId}`)
    check(
      Array.isArray(empKey.body) && empKey.body.length === 0,
      'EMPLOYEE CANNOT READ THE ANSWER KEY over HTTP',
      `employee read an answer key: ${JSON.stringify(empKey.body)?.slice(0, 150)}`,
    )

    const empQuestion = await asUser(refreshedSession.access_token, `questions?select=id&id=eq.${questionId}`)
    check(
      Array.isArray(empQuestion.body) && empQuestion.body.length === 0,
      'employee cannot browse the question bank over HTTP',
      `employee saw ${empQuestion.body?.length} questions`,
    )

    const empWrite = await rpc(refreshedSession.access_token, 'save_question', {
      p_id: null,
      p_type: 'mcq_single',
      p_response_format: 'choice_single',
      p_stem: 'An employee should not be able to write this',
      p_content: questionContent,
      p_answer_key: { format: 'choice_single', correct: 'a' },
    })
    check(
      empWrite.status >= 400,
      'employee is refused by save_question (SECURITY INVOKER holds)',
      `employee write returned ${empWrite.status} — the RPC is bypassing RLS`,
    )

    // ── A reword bumps the revision, over HTTP ─────────────────────────────
    const reworded = await rpc(chefSession.access_token, 'save_question', {
      p_id: questionId,
      p_type: 'mcq_single',
      p_response_format: 'choice_single',
      p_stem: `Walkthrough ${stamp}: what internal temperature must chicken reach?`,
      p_content: questionContent,
      p_answer_key: { format: 'choice_single', correct: 'b' },
      p_change_note: 'reworded',
    })
    check(
      reworded.body?.[0]?.revision === 2,
      'rewording bumps the revision',
      `revision after reword = ${reworded.body?.[0]?.revision}`,
    )

    const { rows: after } = await db.query(
      'select revision, stem, change_note from public.question_revisions where question_id = $1 order by revision',
      [questionId],
    )
    check(
      after.length === 2 && after[0].stem !== after[1].stem,
      'both wordings are preserved in history',
      `history = ${JSON.stringify(after.map((r) => r.revision))}`,
    )
    check(after[1]?.change_note === 'reworded', 'the second note is stamped on revision 2', `note = ${after[1]?.change_note}`)

    // ── Provenance survives the reword ─────────────────────────────────────
    //
    // Asserted against the reword ABOVE rather than an edit of its own: that
    // call sends exactly what saveQuestion() sends — no p_source, no
    // p_imported_from — so it is the real editor path, over real HTTP, with a
    // real token. save_question (0039) coalesces the missing arguments to the
    // stored values.
    //
    // The RLS suite proves the same coalesce against Postgres directly. This
    // proves it through PostgREST, where a named-argument RPC omitting a
    // parameter takes its DEFAULT — if those two ever diverge, an edit starts
    // silently erasing where every imported question came from, and nothing
    // else in the schema remembers it.
    const provenance = await asUser(
      chefSession.access_token,
      `questions?select=source,imported_from,bloom_level&id=eq.${questionId}`,
    )
    check(
      provenance.body?.[0]?.source === 'import' &&
        provenance.body?.[0]?.imported_from === 'walkthrough',
      'A REWORD DOES NOT REWRITE WHERE THE QUESTION CAME FROM',
      `provenance after the reword: ${JSON.stringify(provenance.body?.[0])}`,
    )
    // ┌───────────────────────────────────────────────────────────────────────┐
    // │ AND THE OTHER HALF: bloom_level DOES NOT survive, and must not.        │
    // │                                                                       │
    // │ save_question is a FULL-RECORD WRITE, not a patch. It already          │
    // │ overwrites stem, marks, difficulty and every other column with         │
    // │ whatever the caller sent, so bloom_level behaving the same way is the  │
    // │ consistent answer — and the necessary one, because Bloom is editable   │
    // │ and a coalesce would make it impossible to CLEAR a level set by        │
    // │ mistake.                                                              │
    // │                                                                       │
    // │ source and imported_from are the deliberate exception, because they    │
    // │ are provenance rather than attributes.                                │
    // │                                                                       │
    // │ Asserted rather than left implicit because it is a trap for anything   │
    // │ doing a PARTIAL update: a bulk "set category on 200 questions" routed  │
    // │ through save_question would silently blank the Bloom level, the        │
    // │ explanation and the reference note on every one of them. Bulk          │
    // │ operations must not go through this function.                         │
    // └───────────────────────────────────────────────────────────────────────┘
    check(
      provenance.body?.[0]?.bloom_level === null,
      'a reword that does not mention Bloom clears it — save_question is a full write, not a patch',
      `bloom_level = ${JSON.stringify(provenance.body?.[0]?.bloom_level)}, expected null`,
    )
  }
  // ── 8. Internal RPCs are not a public API ──────────────────────────────────
  //
  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ THIS SECTION EXISTS BECAUSE THE ABSENCE OF IT COST US A REAL BREACH.    │
  // │                                                                         │
  // │ Four SECURITY DEFINER helpers were "protected" by `revoke … from        │
  // │ public`, which does not remove a named role's grant. They stayed        │
  // │ callable over PostgREST by anon — no session, just the publishable key  │
  // │ that ships in every browser bundle — returning whole exam papers,       │
  // │ question stems with options, and staff email addresses.                 │
  // │                                                                         │
  // │ Every other layer was green. The RLS suite could not see it because it  │
  // │ speaks to Postgres directly; CI could not see it because CI re-granted  │
  // │ every function after migrating. Only an HTTP call as an unprivileged    │
  // │ caller could, and nothing made one. Now something does.                 │
  // │                                                                         │
  // │ Add any new SECURITY DEFINER function to this list.                     │
  // └─────────────────────────────────────────────────────────────────────────┘
  console.log('\n8. Internal RPCs are not reachable')

  const INTERNAL_RPCS = [
    ['question_snapshot', { p_question_id: '00000000-0000-0000-0000-000000000001' }],
    ['draw_paper', { p_exam_id: '00000000-0000-0000-0000-000000000001', p_seed: 'x' }],
    ['exam_audience', { p_exam_id: '00000000-0000-0000-0000-000000000001' }],
    [
      'question_pool',
      {
        p_exam_id: '00000000-0000-0000-0000-000000000001',
        p_category_id: null,
        p_include_sub: true,
        p_tag_ids: [],
        p_types: null,
        p_difficulty_min: 1,
        p_difficulty_max: 5,
      },
    ],
    // 0022 — the answer key at a given revision. The single most damaging one
    // on this list: reachable, it hands over the key for any question.
    [
      'answer_key_at_revision',
      { p_question_id: '00000000-0000-0000-0000-000000000001', p_revision: 1 },
    ],
    // 0027 — the grader and its primitives. It takes the key as an argument so
    // it is not an oracle, but it is internal machinery all the same.
    [
      'grade_answer',
      { p_content: {}, p_key: {}, p_answer: {}, p_max: 1, p_negative: 0 },
    ],
    ['grade_normalise', { v: 'x' }],
    ['grade_edit_distance', { a: 'x', b: 'y' }],
    [
      'grade_match_blank',
      { p_submitted: 'x', p_accept: [], p_mode: 'ci', p_tolerance: 1 },
    ],
    // 0027 — closes and grades an attempt with NO authorisation check of its
    // own. Reachable, it would let anyone submit anyone's paper.
    [
      'grade_and_close_attempt',
      { p_attempt_id: '00000000-0000-0000-0000-000000000001', p_reason: 'user' },
    ],
    ['expire_attempts', {}],
  ]

  const callRpc = (name, body, token) =>
    fetch(`${URL_}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: {
        apikey: PUB,
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

  for (const [name, body] of INTERNAL_RPCS) {
    const anon = await callRpc(name, body)
    check(
      anon.status === 401 || anon.status === 403 || anon.status === 404,
      `anon cannot call ${name}`,
      `ANON CAN CALL ${name} — returned ${anon.status}`,
    )

    // The refreshed employee session from section 4 — approved, signed in, and
    // holding none of the exams.* permissions.
    const asEmployee = await callRpc(name, body, refreshedSession.access_token)
    check(
      asEmployee.status === 401 || asEmployee.status === 403 || asEmployee.status === 404,
      `an employee cannot call ${name}`,
      `AN EMPLOYEE CAN CALL ${name} — returned ${asEmployee.status}`,
    )
  }

  // The guarded entry points must still refuse an employee — for the right
  // reason (their own permission check), not because they are unreachable.
  for (const [name, body] of [
    ['exam_paper', { p_exam_id: '00000000-0000-0000-0000-000000000001', p_seed: null }],
    ['exam_health', { p_exam_id: '00000000-0000-0000-0000-000000000001' }],
    // ── The analytics family ───────────────────────────────────────────────
    //
    // All SECURITY DEFINER, all granted to `authenticated`, and all gated by
    // their own analytics_scope() check rather than by a policy — they read
    // attempt data across a whole outlet, which no caller has a policy on.
    //
    // question_stats has been in that position since 0030 and was never
    // asserted here. M9 added two more that read the same tables, so the gap
    // is closed for all three at once rather than for the new ones alone.
    //
    // The distinction this loop draws matters: these must refuse an employee
    // BECAUSE THEY CHECK, not because they are unreachable. A 404 here would
    // mean the grant was lost and every chef lost the feature too.
    ['question_stats', {}],
    ['question_quality', {}],
    ['question_distractors', { p_question_id: '00000000-0000-0000-0000-000000000001' }],
  ]) {
    const res = await callRpc(name, body, refreshedSession.access_token)
    check(
      res.status >= 400,
      `an employee is refused by ${name}`,
      `AN EMPLOYEE REACHED ${name} — returned ${res.status}`,
    )
  }
} catch (e) {
  bad(`walkthrough threw: ${e.message}`)
} finally {
  if (createdQuestions.length) {
    await db.query('delete from public.questions where id = any($1::uuid[])', [createdQuestions])
    console.log(`  🧹 removed ${createdQuestions.length} test question(s)`)
  }
  for (const id of created) {
    await fetch(`${URL_}/auth/v1/admin/users/${id}`, { method: 'DELETE', headers: adminHeaders })
  }
  console.log(`\n  🧹 removed ${created.length} test users`)
  await db.end()
}

console.log(fail === 0 ? '\nWalkthrough passed.\n' : `\n${fail} check(s) failed.\n`)
process.exit(fail === 0 ? 0 : 1)
