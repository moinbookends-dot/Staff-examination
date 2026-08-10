/**
 * ═════════════════════════════════════════════════════════════════════════════
 * SITTING A GENERATED PAPER, END TO END, AS REAL USERS.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ NOTHING HERE USES THE SERVICE ROLE.                                       ║
 * ║                                                                           ║
 * ║ Every call carries a real signed-in user's access token, so RLS and the   ║
 * ║ definer functions are what decide the outcome. A check that passed only   ║
 * ║ because it was made as the owner would prove nothing about the product.   ║
 * ║                                                                           ║
 * ║ The admin connection is used for two things only: reading rows back to    ║
 * ║ assert on them, and deleting what this script created.                    ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Part A publishes a paper as a Chef, sits it as an Employee, submits it, and
 * checks what the grader actually did. Part B then fetches the new routes by
 * DIRECT URL — the answer-key PDF above all, which is a URL an employee can
 * guess the shape of the moment they have sat a paper.
 *
 * Creates one exam and one attempt; removes both, and restores the paper's
 * status, in `finally`.
 *
 * Needs the sample accounts (`npm run db:sample`). Part B additionally needs a
 * dev server; it is skipped, loudly, if APP_URL is not answering.
 *
 *   node scripts/check-delivery.mjs
 *   APP_URL=http://localhost:3001 node scripts/check-delivery.mjs
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

async function signIn(email) {
  const s = await (
    await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    })
  ).json()
  if (!s.access_token) {
    throw new Error(`sign-in failed for ${email} — run \`npm run db:sample\` first`)
  }

  // The same cookie shape @supabase/ssr writes, so the Next routes see a session.
  const name = `sb-${ref}-auth-token`
  const encoded = 'base64-' + Buffer.from(JSON.stringify(s)).toString('base64url')
  const parts = []
  for (let i = 0; i < encoded.length; i += 3180) parts.push(encoded.slice(i, i + 3180))
  const cookie =
    parts.length === 1
      ? `${name}=${parts[0]}`
      : parts.map((p, i) => `${name}.${i}=${p}`).join('; ')

  return { token: s.access_token, cookie }
}

/**
 * A PostgREST RPC as that user. Never throws — the status IS the assertion.
 *
 * Takes the whole user object rather than a bare token on purpose. Passing the
 * object where a token was wanted produced `Expected 3 parts in JWT; got 1` —
 * a 401 that read as a PASS on every "this role may not do X" check, because
 * the call failed for the wrong reason. Refused and malformed must not be
 * indistinguishable, so there is now only one thing a caller can pass.
 */
async function rpc(user, fn, args) {
  const res = await fetch(`${SUPABASE}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${user.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args ?? {}),
  })
  const text = await res.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return res.ok ? { ok: true, data: body } : { ok: false, error: body, status: res.status }
}

function verdict(status) {
  if (status === 200) return 'ALLOW'
  if (status === 307 || status === 302) return 'REDIRECT'
  if (status === 403) return 'DENY(403)'
  if (status === 500) return 'DENY(500)'
  if (status === 404) return 'NOTFOUND'
  return `OTHER(${status})`
}

let examId = null
let attemptId = null
let paperId = null
let paperWas = null

try {
  await db.connect()

  const chef = await signIn('sample-chef@example.com')
  const employee = await signIn('sample-employee@example.com')
  const editor = await signIn('editor@example.com')

  const [{ id: employeeId, outlet_id: outletId }] = (
    await db.query(`select id, outlet_id from public.profiles where email = 'sample-employee@example.com'`)
  ).rows
  /*
   * A paper with no OPEN exam against it.
   *
   * "The newest paper" was wrong: publishing is once-per-paper by design, so
   * the moment somebody publishes the newest one by hand this script fails on
   * their row and — worse — its cleanup would be tempted to delete an exam it
   * did not create. It picks a free paper instead, and says so if there is none.
   */
  const [paper] = (
    await db.query(
      `select p.id, p.paper_no, p.marks, p.mcq_n, p.short_n, p.status
         from public.exam_papers p
        where p.status <> 'retired'
          and not exists (
            select 1 from public.exams e
             where e.paper_id = p.id
               and e.deleted_at is null
               and e.status in ('draft', 'scheduled', 'active'))
        order by p.generated_at desc limit 1`,
    )
  ).rows
  if (!paper) {
    throw new Error(
      'every generated paper is already published as an open exam — generate one, or archive an exam, and re-run',
    )
  }
  paperId = paper.id
  paperWas = paper.status

  console.log(`\n  Paper #${paper.paper_no} — ${paper.marks} marks (${paper.mcq_n} MCQ + ${paper.short_n} short)`)

  // ── A1. Who may publish ──────────────────────────────────────────────────
  console.log('\n=== who may publish ===')
  const asEmployee = await rpc(employee, 'publish_paper_as_exam', {
    p_paper_id: paper.id, p_title: 'x', p_duration_minutes: 30,
    p_opens_at: null, p_closes_at: null, p_max_attempts: 1,
    p_pass_mark_percent: 60, p_instructions: null,
  })
  check('an employee cannot publish', !asEmployee.ok, `${asEmployee.status}`)

  const asEditor = await rpc(editor, 'publish_paper_as_exam', {
    p_paper_id: paper.id, p_title: 'x', p_duration_minutes: 30,
    p_opens_at: null, p_closes_at: null, p_max_attempts: 1,
    p_pass_mark_percent: 60, p_instructions: null,
  })
  check('an editor cannot publish — they author, chefs run exams', !asEditor.ok, `${asEditor.status}`)

  const published = await rpc(chef, 'publish_paper_as_exam', {
    p_paper_id: paper.id,
    p_title: `Delivery check — paper ${paper.paper_no}`,
    p_duration_minutes: 45, p_opens_at: null, p_closes_at: null,
    p_max_attempts: 1, p_pass_mark_percent: 60, p_instructions: null,
  })
  check('a chef can publish', published.ok, JSON.stringify(published.error ?? '').slice(0, 120))
  if (!published.ok) throw new Error('cannot continue without an exam')
  examId = published.data.examId

  // ── A2. What publishing produced ─────────────────────────────────────────
  console.log('\n=== the exam publishing produced ===')
  const [exam] = (await db.query(`select * from public.exams where id = $1`, [examId])).rows
  check('it points at the paper', exam.paper_id === paper.id)
  check('it is scheduled', exam.status === 'scheduled')
  check('both shuffles are OFF — printed order must survive', !exam.shuffle_questions && !exam.shuffle_options)
  // numeric comes back from node-postgres as a string.
  check('total_marks came from the paper', Number(exam.total_marks) === paper.marks)
  check('question_count came from the paper', exam.question_count === paper.mcq_n + paper.short_n)
  check('manual grading is on — the blueprint always has short answers', exam.requires_manual_grading === true)

  const [{ status: paperNow }] = (await db.query(`select status from public.exam_papers where id = $1`, [paper.id])).rows
  check('the paper is now live', paperNow === 'live')

  const [{ n: paperRows }] = (await db.query(
    `select count(*)::int n from public.exam_paper_questions where paper_id = $1`, [paper.id])).rows
  check('the paper itself was not rewritten', paperRows === paper.mcq_n + paper.short_n)

  const twice = await rpc(chef, 'publish_paper_as_exam', {
    p_paper_id: paper.id, p_title: 'again', p_duration_minutes: 30,
    p_opens_at: null, p_closes_at: null, p_max_attempts: 1,
    p_pass_mark_percent: 60, p_instructions: null,
  })
  check('the same paper cannot be open as two exams', !twice.ok, `${twice.status}`)

  // ── A3. Assignment is the gate ───────────────────────────────────────────
  console.log('\n=== assignment is the gate ===')
  const unassigned = await rpc(employee, 'start_attempt', { p_exam_id: examId })
  check('an unassigned exam cannot be started', !unassigned.ok, `${unassigned.status}`)

  await db.query(
    `insert into public.exam_assignments (exam_id, target_kind, target_id, assigned_by)
     values ($1, 'outlet', $2, (select id from public.profiles where email = 'sample-chef@example.com'))`,
    [examId, outletId],
  )

  // ── A4. Sitting it ───────────────────────────────────────────────────────
  console.log('\n=== sitting the paper ===')
  const started = await rpc(employee, 'start_attempt', { p_exam_id: examId })
  check('it can be started once assigned', started.ok, JSON.stringify(started.error ?? '').slice(0, 140))
  if (!started.ok) throw new Error('cannot continue without an attempt')
  attemptId = started.data[0].attempt_id
  check('every question was frozen', started.data[0].question_count === paper.marks)

  const frozen = (await db.query(
    `select source, answer_key, snapshot ->> 'response_format' fmt
       from public.attempt_questions where attempt_id = $1 order by position`,
    [attemptId],
  )).rows
  check('every frozen row says source = bank', frozen.every((r) => r.source === 'bank'))
  check('every frozen row carries its own key', frozen.every((r) => r.answer_key !== null))
  check(
    `the split is ${paper.mcq_n} MCQ + ${paper.short_n} short, as printed`,
    frozen.filter((r) => r.fmt === 'choice_single').length === paper.mcq_n &&
      frozen.filter((r) => r.fmt === 'text_short').length === paper.short_n,
  )

  const served = await rpc(employee, 'attempt_paper', { p_attempt_id: attemptId, p_locale: 'hi' })
  check('the candidate can read their own paper', served.ok)
  const servedText = JSON.stringify(served.data ?? [])
  check('NO answer key reaches the candidate', !/"correct"|answer_key|"model"/.test(servedText))
  check('no other language is shipped to the candidate', !servedText.includes('"i18n"'))
  check('it is served in Hindi', /[ऀ-ॿ]/.test(servedText))

  // ── A5. Answering, deliberately imperfectly ──────────────────────────────
  console.log('\n=== answering, then submitting ===')
  const sheet = (await db.query(
    `select question_id, answer_key, snapshot ->> 'response_format' fmt
       from public.attempt_questions where attempt_id = $1 order by position`,
    [attemptId],
  )).rows

  let expected = 0
  let i = 0
  for (const row of sheet) {
    if (row.fmt === 'choice_single') {
      // Every third MCQ is answered wrong on purpose: a full-marks run would
      // pass even if the key comparison were inverted.
      const correct = row.answer_key.correct
      const pick = i % 3 === 0 ? ['a', 'b', 'c', 'd'].find((c) => c !== correct) : correct
      if (pick === correct) expected++
      await rpc(employee, 'save_answer', {
        p_attempt_id: attemptId, p_question_id: row.question_id,
        p_answer: { format: 'choice_single', choice: pick },
      })
    } else {
      await rpc(employee, 'save_answer', {
        p_attempt_id: attemptId, p_question_id: row.question_id,
        p_answer: { format: 'text_short', text: 'A written answer for the evaluator.' },
      })
    }
    i++
  }

  const submitted = await rpc(employee, 'submit_attempt', { p_attempt_id: attemptId, p_reason: 'user' })
  check('submit succeeds', submitted.ok, JSON.stringify(submitted.error ?? '').slice(0, 140))

  const [att] = (await db.query(
    `select status, score, max_score, passed from public.attempts where id = $1`, [attemptId])).rows
  check('it went to a human, not straight to a result', att.status === 'evaluating', `status=${att.status}`)
  check('the MCQs scored exactly what they should', Number(att.score) === expected, `got ${att.score}, expected ${expected}`)
  check('max_score is the whole paper', Number(att.max_score) === paper.marks)
  check('no pass/fail verdict before a human finishes', att.passed === null)

  const byFormat = (await db.query(
    `select aq.snapshot ->> 'response_format' fmt, aa.auto_grade_status st, count(*)::int n
       from public.attempt_answers aa
       join public.attempt_questions aq
         on aq.attempt_id = aa.attempt_id and aq.question_id = aa.question_id
      where aa.attempt_id = $1 group by 1, 2`,
    [attemptId],
  )).rows
  check(
    'short answers wait for a human and MCQs do not',
    byFormat.every((g) => (g.fmt === 'text_short') === (g.st === 'not_applicable')),
    byFormat.map((g) => `${g.fmt}/${g.st}=${g.n}`).join(' '),
  )

  // ── A6. What the candidate may never reach ───────────────────────────────
  console.log('\n=== what a candidate may never reach ===')
  const others = (await db.query(
    `select id from public.attempts where candidate_id <> $1 limit 1`, [employeeId])).rows[0]
  if (others) {
    const peek = await rpc(employee, 'attempt_paper', { p_attempt_id: others.id, p_locale: 'en' })
    check("another candidate's paper", !peek.ok || (peek.data ?? []).length === 0)
    const review = await rpc(employee, 'attempt_review', { p_attempt_id: others.id })
    check("another candidate's review", !review.ok || (review.data ?? []).length === 0)
  }

  const retire = await rpc(employee, 'set_paper_status', { p_paper_id: paper.id, p_status: 'retired' })
  check("a paper's status", !retire.ok, `${retire.status}`)

  const bankText = await fetch(`${SUPABASE}/rest/v1/bank_question_texts?select=question&limit=1`, {
    headers: { apikey: ANON, Authorization: `Bearer ${employee.token}` },
  })
  const bankBody = await bankText.text()
  check('bank question text, read directly', bankBody === '[]' || !bankText.ok, `${bankText.status} ${bankBody.slice(0, 30)}`)

  const keys = await fetch(
    `${SUPABASE}/rest/v1/attempt_questions?select=answer_key&attempt_id=eq.${attemptId}`,
    { headers: { apikey: ANON, Authorization: `Bearer ${employee.token}` } },
  )
  const keysBody = await keys.text()
  check('the keys on their OWN attempt', keysBody === '[]' || !keys.ok, `${keys.status} ${keysBody.slice(0, 40)}`)

  // ── B. The same questions, asked of the routes ───────────────────────────
  const reachable = await fetch(`${APP}/en/login`, { redirect: 'manual' })
    .then((r) => r.ok || r.status === 307)
    .catch(() => false)

  if (!reachable) {
    console.log(`\n=== direct-URL probes SKIPPED — nothing answering at ${APP} ===`)
    console.log('    Start the dev server, or pass APP_URL, to include them.')
  } else {
    console.log(`\n=== direct URL, as an employee — the nav is never consulted (${APP}) ===`)

    const ROUTES = [
      [`/en/my-exams`, 'ALLOW', 'their own list'],
      [`/en/attempt/${attemptId}`, 'ALLOW', 'their own attempt'],
      [`/en/results`, 'ALLOW', 'their own results'],
      [`/en/history`, 'DENY', 'paper history'],
      [`/en/history/${paperId}`, 'DENY', 'the paper'],
      [`/en/papers/generate`, 'DENY', 'the generator'],
      [`/en/exams/${examId}`, 'DENY', 'the exam admin screen'],
      [`/en/exams`, 'DENY', 'the exam list'],
      [`/en/questions`, 'DENY', 'the question bank'],
      [`/en/settings`, 'DENY', 'settings'],
      [`/en/evaluate`, 'DENY', 'the marking queue'],
      [`/api/papers/${paperId}/en/paper.pdf`, 'DENY', 'THE PRINTED PAPER'],
      [`/api/papers/${paperId}/en/key.pdf`, 'DENY', 'THE ANSWER KEY'],
      [`/api/papers/${paperId}/hi/key.pdf`, 'DENY', 'the answer key, Hindi'],
    ]
    if (others) ROUTES.push([`/en/attempt/${others.id}`, 'DENY', "another candidate's attempt"])

    /** Anything in a denied body that would mean content escaped on the way out. */
    const LEAK = /"correct"\s*:|answer_key|correctOption|bank_question|"option_a"/

    for (const [path, expect, note] of ROUTES) {
      const res = await fetch(`${APP}${path}`, { headers: { cookie: employee.cookie }, redirect: 'manual' })
      const body = await res.text()
      const got = verdict(res.status)
      const pass = expect === 'ALLOW' ? got === 'ALLOW' : got !== 'ALLOW'

      check(`${expect.padEnd(5)} ${note}`, pass, `${got}  ${path.slice(0, 46)}`)
      if (got !== 'ALLOW' && LEAK.test(body)) {
        fails++
        console.log(`        !! the denied body LEAKED content`)
      }
    }

    const own = await fetch(`${APP}/en/attempt/${attemptId}`, { headers: { cookie: employee.cookie } })
    const ownBody = await own.text()
    check('the attempt page ships no answer key to the browser',
      !/"correct"\s*:|answer_key|"model"\s*:/.test(ownBody))
  }
} catch (err) {
  fails++
  console.error('\n  THREW: ' + err.message)
} finally {
  console.log('\n=== cleanup ===')
  try {
    if (attemptId) {
      await db.query(`delete from public.attempt_answers where attempt_id = $1`, [attemptId])
      await db.query(`delete from public.attempt_questions where attempt_id = $1`, [attemptId])
      await db.query(`delete from public.attempts where id = $1`, [attemptId])
    }
    if (examId) {
      await db.query(`delete from public.exam_assignments where exam_id = $1`, [examId])
      await db.query(`delete from public.exams where id = $1`, [examId])
    }
    if (paperId && paperWas) {
      await db.query(
        `update public.exam_papers
            set status = $2, status_changed_at = null, status_changed_by = null
          where id = $1`,
        [paperId, paperWas],
      )
    }
    console.log('  exam and attempt removed, paper status restored')
  } catch (e) {
    console.error('  cleanup problem: ' + e.message)
  }
  await db.end()
}

console.log(fails === 0 ? '\n  ALL CHECKS PASSED\n' : `\n  ${fails} CHECK(S) FAILED\n`)
process.exitCode = fails ? 1 : 0
