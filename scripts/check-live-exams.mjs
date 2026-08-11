/**
 * ═════════════════════════════════════════════════════════════════════════════
 * THE LIVE EXAM LIFECYCLE, AS REAL USERS.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ NOTHING HERE USES THE SERVICE ROLE FOR THE THING BEING TESTED.            ║
 * ║                                                                           ║
 * ║ Every publish, start, save and submit carries a real signed-in user's     ║
 * ║ token, so RLS and the definer functions decide the outcome. The admin     ║
 * ║ connection is used only to read rows back for assertions, and to move a   ║
 * ║ deadline into the past — which no user-facing path can do, and which is   ║
 * ║ the only way to test "after the deadline" without waiting for one.        ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Covers, in order: publish validation, the five exam states, the timing
 * boundaries, attempt limits, both results-release policies, participation
 * counting, and the direct-URL permission matrix for the three new sections.
 *
 * Reuses ONE paper for every scenario, publishing and removing it each time,
 * because 0062's index allows a paper only one open exam at a time — which is
 * itself one of the things asserted.
 *
 *   APP_URL=http://localhost:3000 node scripts/check-live-exams.mjs
 * ═════════════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'

const APP = process.env.APP_URL ?? 'http://localhost:3000'
const PASSWORD = 'Sample-2026!'

const env = {}
for (const line of readFileSync(resolve('.env.local'), 'utf-8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m) env[m[1]] = m[2].trim()
}
const SUPABASE = env.NEXT_PUBLIC_SUPABASE_URL
const ANON = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
const ref = new URL(SUPABASE).hostname.split('.')[0]

const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST ?? 'aws-0-ap-southeast-1.pooler.supabase.com',
  port: 5432,
  user: `postgres.${ref}`,
  password: env.SUPABASE_DB_PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
})

let fails = 0
const check = (label, pass, detail = '') => {
  if (!pass) fails++
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
}
const section = (s) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 62 - s.length))}`)

async function signIn(email) {
  const s = await (
    await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    })
  ).json()
  if (!s.access_token) throw new Error(`sign-in failed for ${email} — run \`npm run db:sample\``)

  const name = `sb-${ref}-auth-token`
  const encoded = 'base64-' + Buffer.from(JSON.stringify(s)).toString('base64url')
  const parts = []
  for (let i = 0; i < encoded.length; i += 3180) parts.push(encoded.slice(i, i + 3180))
  return {
    token: s.access_token,
    cookie: parts.length === 1
      ? `${name}=${parts[0]}`
      : parts.map((p, i) => `${name}.${i}=${p}`).join('; '),
  }
}

/** RPC as that user. Takes the whole user object — see check-delivery.mjs. */
async function rpc(user, fn, args) {
  const res = await fetch(`${SUPABASE}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: ANON, Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json',
    },
    body: JSON.stringify(args ?? {}),
  })
  const text = await res.text()
  let body
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return res.ok ? { ok: true, data: body } : { ok: false, error: body, status: res.status }
}

const iso = (msFromNow) => new Date(Date.now() + msFromNow).toISOString()
const MIN = 60_000
const HOUR = 60 * MIN

let paperId = null
let paperWas = null
const madeExams = []

/** Publish, remembering the exam so cleanup can find it even on a throw. */
async function publish(user, over = {}) {
  const r = await rpc(user, 'publish_paper_as_exam', {
    p_paper_id: paperId,
    p_title: 'Live check',
    p_duration_minutes: 30,
    p_opens_at: null,
    p_closes_at: iso(2 * HOUR),
    p_max_attempts: 1,
    p_pass_mark_percent: 60,
    p_instructions: null,
    p_results_release: 'immediate',
    ...over,
  })
  if (r.ok && r.data?.examId) madeExams.push(r.data.examId)
  return r
}

async function removeExam(examId) {
  await db.query(
    `delete from public.attempt_answers where attempt_id in
       (select id from public.attempts where exam_id = $1)`, [examId])
  await db.query(
    `delete from public.attempt_questions where attempt_id in
       (select id from public.attempts where exam_id = $1)`, [examId])
  await db.query(`delete from public.attempts where exam_id = $1`, [examId])
  await db.query(`delete from public.exam_assignments where exam_id = $1`, [examId])
  await db.query(`delete from public.exams where id = $1`, [examId])
  const i = madeExams.indexOf(examId)
  if (i >= 0) madeExams.splice(i, 1)
}

async function assign(examId, outletId) {
  await db.query(
    `insert into public.exam_assignments (exam_id, target_kind, target_id, assigned_by)
     values ($1, 'outlet', $2, (select id from public.profiles where email='sample-chef@example.com'))`,
    [examId, outletId])
}

try {
  await db.connect()

  const chef = await signIn('sample-chef@example.com')
  const employee = await signIn('sample-employee@example.com')
  const editor = await signIn('editor@example.com')
  const hr = await signIn('sample-hr@example.com')

  const [{ outlet_id: outletId }] = (
    await db.query(`select outlet_id from public.profiles where email='sample-employee@example.com'`)
  ).rows

  const [paper] = (
    await db.query(
      `select p.id, p.paper_no, p.marks, p.status, p.status_changed_at, p.status_changed_by
         from public.exam_papers p
        where p.status <> 'retired'
          and not exists (
            select 1 from public.exams e
             where e.paper_id = p.id and e.deleted_at is null
               and e.status in ('draft','scheduled','active'))
        order by p.generated_at desc limit 1`)
  ).rows
  if (!paper) throw new Error('no free paper — every generated paper is already published')
  paperId = paper.id
  paperWas = { status: paper.status, at: paper.status_changed_at, by: paper.status_changed_by }

  console.log(`\n  Paper #${paper.paper_no}, ${paper.marks} marks`)

  // ── Publish validation ──────────────────────────────────────────────────
  section('publish validation refuses a half-configured exam')

  const bad = [
    ['no title', { p_title: '   ' }],
    ['no deadline', { p_closes_at: null }],
    ['deadline before start', { p_opens_at: iso(2 * HOUR), p_closes_at: iso(HOUR) }],
    ['deadline already passed', { p_closes_at: iso(-HOUR) }],
    ['duration too short', { p_duration_minutes: 1 }],
    ['duration too long', { p_duration_minutes: 900 }],
    ['zero attempts', { p_max_attempts: 0 }],
    ['pass mark over 100', { p_pass_mark_percent: 101 }],
  ]
  for (const [label, over] of bad) {
    const r = await publish(chef, over)
    check(`refused: ${label}`, !r.ok, r.ok ? 'PUBLISHED ANYWAY' : `${r.status}`)
    if (r.ok) await removeExam(r.data.examId)
  }

  // ── The five states ─────────────────────────────────────────────────────
  section('exam states derive from the window')

  const scheduled = await publish(chef, { p_opens_at: iso(HOUR), p_closes_at: iso(2 * HOUR) })
  check('a future exam publishes', scheduled.ok, JSON.stringify(scheduled.error ?? '').slice(0, 90))
  const schedId = scheduled.data.examId

  const stateOf = async (id) =>
    (await db.query(
      `select public.exam_state(status, opens_at, closes_at) s from public.exams where id=$1`, [id]
    )).rows[0].s

  check('before its start it is SCHEDULED', (await stateOf(schedId)) === 'scheduled')

  await assign(schedId, outletId)
  const early = await rpc(employee, 'start_attempt', { p_exam_id: schedId })
  check('a candidate cannot start before the start time', !early.ok, `${early.status}`)

  /*
   * ┌───────────────────────────────────────────────────────────────────────────┐
   * │ THE START TIME CANNOT BE MOVED, SO THE LIVE CASE IS A SECOND EXAM.        │
   * │                                                                           │
   * │ This script first tried to drag opens_at into the past to turn the        │
   * │ scheduled exam live, and 0016's immutability trigger refused: "only its   │
   * │ closing time, status and assignments can change". That refusal is the     │
   * │ product working — a published exam whose start time could be moved is an  │
   * │ exam that can open early underneath the people sitting it — so the test   │
   * │ was changed rather than the rule.                                         │
   * │                                                                           │
   * │ An exam published with no opening time is live from the moment it exists, │
   * │ which is the same state by a legitimate route.                            │
   * └───────────────────────────────────────────────────────────────────────────┘
   */
  await removeExam(schedId)

  const liveExam = await publish(chef, { p_opens_at: null, p_closes_at: iso(2 * HOUR) })
  check('an exam with no start time publishes', liveExam.ok,
    JSON.stringify(liveExam.error ?? '').slice(0, 90))
  const liveId = liveExam.data.examId
  await assign(liveId, outletId)

  check('with no start time it is LIVE at once', (await stateOf(liveId)) === 'live')

  const started = await rpc(employee, 'start_attempt', { p_exam_id: liveId })
  check('a candidate can start once it is live', started.ok, JSON.stringify(started.error ?? '').slice(0, 90))
  const attemptId = started.ok ? started.data[0].attempt_id : null

  // ── Attempt limit ───────────────────────────────────────────────────────
  section('attempt limits')

  const resume = await rpc(employee, 'start_attempt', { p_exam_id: liveId })
  check('starting again RESUMES rather than creating a second attempt',
    resume.ok && resume.data[0].attempt_id === attemptId)

  const [{ n: attemptRows }] = (
    await db.query(`select count(*)::int n from public.attempts where exam_id=$1`, [liveId])
  ).rows
  check('exactly one attempt row exists', attemptRows === 1, `${attemptRows}`)

  // ── After the deadline ──────────────────────────────────────────────────
  section('the deadline is enforced by the server')

  await db.query(`update public.exams set closes_at = now() - interval '1 minute' where id=$1`, [liveId])
  check('past the deadline it is CLOSED', (await stateOf(liveId)) === 'closed')

  const firstQuestion = (await db.query(
    `select question_id from public.attempt_questions where attempt_id=$1 limit 1`, [attemptId]
  )).rows[0].question_id

  /*
   * ┌───────────────────────────────────────────────────────────────────────────┐
   * │ AN IN-FLIGHT ATTEMPT KEEPS ITS OWN CLOCK, AND THAT IS THE RULE.          │
   * │                                                                           │
   * │ This first asserted that moving the exam's deadline into the past stopped │
   * │ a running attempt, and it did not. start_attempt() fixes expires_at at    │
   * │ least(now + duration, closes_at) WHEN THE ATTEMPT BEGINS, and save_answer │
   * │ checks that stamp — so somebody who legitimately started keeps the time   │
   * │ they were given even if an administrator shortens the window underneath   │
   * │ them.                                                                     │
   * │                                                                           │
   * │ That is the correct behaviour, not a gap: the alternative cuts a          │
   * │ candidate off mid-question for an edit they had no part in. So the test   │
   * │ now asserts the rule that actually governs saving — the ATTEMPT's own     │
   * │ expiry — and separately that no NEW attempt can begin once the exam has   │
   * │ closed.                                                                   │
   * └───────────────────────────────────────────────────────────────────────────┘
   */
  const stillOpen = await rpc(employee, 'save_answer', {
    p_attempt_id: attemptId,
    p_question_id: firstQuestion,
    p_answer: { format: 'choice_single', choice: 'a' },
  })
  check('a running attempt keeps its own clock when the exam deadline moves',
    stillOpen.ok, JSON.stringify(stillOpen.error ?? '').slice(0, 80))

  /*
   * BOTH timestamps move. `attempts_window_ordered` requires expires_at to be
   * after started_at, so backdating only the expiry violates the constraint —
   * which is the schema correctly refusing an attempt that ended before it
   * began. Backdating the start too produces an attempt that ran and lapsed.
   */
  await db.query(
    `update public.attempts
        set started_at = now() - interval '2 hours',
            expires_at = now() - interval '1 minute'
      where id = $1`, [attemptId])
  const late = await rpc(employee, 'save_answer', {
    p_attempt_id: attemptId,
    p_question_id: firstQuestion,
    p_answer: { format: 'choice_single', choice: 'b' },
  })
  check('an answer after the ATTEMPT expires is refused', !late.ok, `${late.status}`)

  const lateStart = await rpc(employee, 'start_attempt', { p_exam_id: liveId })
  check('a new attempt after the deadline is refused', !lateStart.ok, `${lateStart.status}`)

  await removeExam(liveId)

  // ── Results release ─────────────────────────────────────────────────────
  section('results release')

  for (const policy of ['immediate', 'on_close']) {
    const pub = await publish(chef, { p_results_release: policy, p_closes_at: iso(2 * HOUR) })
    const examId = pub.data.examId
    await assign(examId, outletId)

    const s = await rpc(employee, 'start_attempt', { p_exam_id: examId })
    const aid = s.data[0].attempt_id

    // Answer every question, then submit — the real path.
    const sheet = (await db.query(
      `select question_id, answer_key, snapshot->>'response_format' fmt
         from public.attempt_questions where attempt_id=$1 order by position`, [aid])).rows
    for (const row of sheet) {
      await rpc(employee, 'save_answer', {
        p_attempt_id: aid,
        p_question_id: row.question_id,
        p_answer: row.fmt === 'choice_single'
          ? { format: 'choice_single', choice: row.answer_key.correct }
          : { format: 'text_short', text: 'An answer.' },
      })
    }
    await rpc(employee, 'submit_attempt', { p_attempt_id: aid, p_reason: 'user' })

    // Short answers always route to a human, so nothing is releasable yet.
    await rpc(chef, 'release_due_results')
    let st = (await db.query(`select status from public.attempts where id=$1`, [aid])).rows[0].status
    check(`${policy}: nothing released while marking is outstanding`, st === 'evaluating', st)

    // Stand in for the evaluator finishing.
    await db.query(`update public.attempts set status='evaluated' where id=$1`, [aid])

    await rpc(chef, 'release_due_results')
    st = (await db.query(`select status from public.attempts where id=$1`, [aid])).rows[0].status

    if (policy === 'immediate') {
      check('immediate: released as soon as marking is done', st === 'published', st)
    } else {
      check('on_close: still held while the exam is open', st === 'evaluated', st)

      await db.query(`update public.exams set closes_at = now() - interval '1 minute' where id=$1`, [examId])
      await rpc(chef, 'release_due_results')
      st = (await db.query(`select status from public.attempts where id=$1`, [aid])).rows[0].status
      check('on_close: released once the exam closes', st === 'published', st)
    }

    await removeExam(examId)
  }

  // ── Participation ───────────────────────────────────────────────────────
  section('participation counting and who may read it')

  const monitored = await publish(chef, { p_closes_at: iso(2 * HOUR) })
  const monId = monitored.data.examId
  await assign(monId, outletId)

  const p0 = await rpc(chef, 'exam_participation', { p_exam_id: monId })
  check('participation is readable by a chef', p0.ok)
  const before = p0.data?.[0]
  check('everybody starts as not-started',
    before && before.not_started === before.eligible && before.in_progress === 0,
    JSON.stringify(before))

  await rpc(employee, 'start_attempt', { p_exam_id: monId })
  const p1 = (await rpc(chef, 'exam_participation', { p_exam_id: monId })).data?.[0]
  check('starting moves one person into in-progress',
    p1 && p1.in_progress === 1 && p1.not_started === before.eligible - 1,
    JSON.stringify(p1))

  const asEmployee = await rpc(employee, 'exam_participation', { p_exam_id: monId })
  check('a candidate cannot read participation', !asEmployee.ok, `${asEmployee.status}`)

  const partsChef = await rpc(chef, 'exam_participants', { p_exam_id: monId })
  check('a chef can read the per-employee table', partsChef.ok)
  const leaked = (partsChef.data ?? []).filter((r) => r.score !== null)
  check('the table withholds a score that has not been released',
    leaked.length === 0,
    leaked.length ? `${leaked.length} score(s) LEAKED before release` : '')

  const partsEditor = await rpc(editor, 'exam_participants', { p_exam_id: monId })
  check('an editor cannot read the per-employee table', !partsEditor.ok, `${partsEditor.status}`)

  const partsEmployee = await rpc(employee, 'exam_participants', { p_exam_id: monId })
  check('a candidate cannot read the per-employee table', !partsEmployee.ok, `${partsEmployee.status}`)

  const partsHr = await rpc(hr, 'exam_participants', { p_exam_id: monId })
  check('HR can read the per-employee table (attempts.read_all)', partsHr.ok, `${partsHr.status ?? ''}`)

  // ── Direct URL, the three new sections ──────────────────────────────────
  const reachable = await fetch(`${APP}/en/login`, { redirect: 'manual' })
    .then((r) => r.ok || r.status === 307).catch(() => false)

  if (!reachable) {
    section(`direct-URL probes SKIPPED — nothing answering at ${APP}`)
  } else {
    section(`direct URL, by typing the address (${APP})`)

    const people = { chef, editor, hr, employee }
    const expect = {
      '/en/exams/live':     { chef: 'ALLOW', editor: 'DENY', hr: 'ALLOW', employee: 'DENY' },
      '/en/exams/upcoming': { chef: 'ALLOW', editor: 'DENY', hr: 'ALLOW', employee: 'DENY' },
      '/en/exams/closed':   { chef: 'ALLOW', editor: 'DENY', hr: 'ALLOW', employee: 'DENY' },
    }

    /*
     * `/en/exams/${monId}` used to be in that matrix and is not any more.
     *
     * There has never been a per-exam page under this tree — monitoring is a
     * row on the three section pages, expanded from exam_participation() — and
     * the consolidation removed /exams/[id] along with the rest of the
     * authoring area. The chef row expected ALLOW and would now fail on a 404,
     * which reads as a permission bug rather than a deleted route.
     *
     * Asserted the other way instead, because a DENY expectation is satisfied
     * by a 404 and would have gone on "passing" against a page that no longer
     * exists — for everyone, including the chef.
     */
    const gone = await fetch(`${APP}/en/exams/${monId}`, {
      headers: { cookie: chef.cookie },
      redirect: 'manual',
    })
    check('there is no per-exam admin page left behind', gone.status === 404, `got ${gone.status}`)

    for (const [path, wanted] of Object.entries(expect)) {
      for (const [who, user] of Object.entries(people)) {
        const res = await fetch(`${APP}${path}`, { headers: { cookie: user.cookie }, redirect: 'manual' })
        const body = await res.text()
        const allowed = res.status === 200
        const want = wanted[who] === 'ALLOW'
        check(`${wanted[who].padEnd(5)} ${who.padEnd(9)} ${path.slice(0, 40)}`,
          allowed === want, `got ${res.status}`)

        // A refused page must not have leaked a name or a score on the way out.
        if (!want && /"score"|sample-employee@example\.com/.test(body)) {
          fails++
          console.log('        !! the denied body LEAKED participant data')
        }
      }
    }

    const out = await fetch(`${APP}/en/exams/live`, { redirect: 'manual' })
    check('signed out is redirected away from live exams', out.status === 307 || out.status === 302,
      `${out.status}`)
  }

  await removeExam(monId)
} catch (err) {
  fails++
  console.error('\n  THREW: ' + err.message)
} finally {
  section('cleanup')
  try {
    for (const id of [...madeExams]) await removeExam(id)
    if (paperId && paperWas) {
      await db.query(
        `update public.exam_papers
            set status = $2, status_changed_at = $3, status_changed_by = $4
          where id = $1`,
        [paperId, paperWas.status, paperWas.at, paperWas.by])
    }
    console.log('  exams removed, paper status restored')
  } catch (e) {
    console.error('  cleanup problem: ' + e.message)
  }
  await db.end()
}

console.log(fails === 0 ? '\n  ALL CHECKS PASSED\n' : `\n  ${fails} CHECK(S) FAILED\n`)
process.exitCode = fails ? 1 : 0
