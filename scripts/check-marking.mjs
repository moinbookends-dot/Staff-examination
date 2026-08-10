/**
 * ═════════════════════════════════════════════════════════════════════════════
 * MARKING, AND WHO MAY SEE THE MODEL ANSWER.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE MODEL ANSWER IS THE MOST SENSITIVE STRING IN THE PRODUCT.             ║
 * ║                                                                           ║
 * ║ It is the answer to a question somebody is being tested on, and it is     ║
 * ║ frozen onto the attempt the candidate is holding. Every route a candidate ║
 * ║ can reach is probed here with the real model text, and the assertion is   ║
 * ║ on the RESPONSE BODY — not on a status code, because a 200 that quietly   ║
 * ║ carries the key is exactly the failure worth catching.                    ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Also covers the bug 0066 fixed: attempt_evaluation_items() raised P0002 for
 * every paper-backed attempt, so the marking view was unreachable and every
 * submitted paper was stuck at `evaluating`.
 *
 * Publishes one exam, sits it, marks it, and removes everything in `finally`.
 *
 *   APP_URL=http://localhost:3000 node scripts/check-marking.mjs
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
const section = (s) => console.log(`\n── ${s} ${'─'.repeat(Math.max(0, 60 - s.length))}`)

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
  return { ok: res.ok, status: res.status, data: body, text }
}

let examId = null
let attemptId = null
let paperId = null
let paperWas = null

try {
  await db.connect()

  const chef = await signIn('sample-chef@example.com')
  const employee = await signIn('sample-employee@example.com')
  const hr = await signIn('sample-hr@example.com')
  const editor = await signIn('editor@example.com')

  const [{ outlet_id: outletId }] = (
    await db.query(`select outlet_id from public.profiles where email='sample-employee@example.com'`)
  ).rows

  const [paper] = (
    await db.query(
      `select p.id, p.paper_no, p.status, p.status_changed_at, p.status_changed_by
         from public.exam_papers p
        where p.status <> 'retired'
          and not exists (
            select 1 from public.exams e
             where e.paper_id = p.id and e.deleted_at is null
               and e.status in ('draft','scheduled','active'))
        order by p.generated_at desc limit 1`)
  ).rows
  if (!paper) throw new Error('no free paper to publish')
  paperId = paper.id
  paperWas = { status: paper.status, at: paper.status_changed_at, by: paper.status_changed_by }

  // ── Get a paper to the marking queue ─────────────────────────────────────
  const pub = await rpc(chef, 'publish_paper_as_exam', {
    p_paper_id: paperId, p_title: 'Marking check', p_duration_minutes: 30,
    p_opens_at: null, p_closes_at: new Date(Date.now() + 2 * 3600_000).toISOString(),
    p_max_attempts: 1, p_pass_mark_percent: 60, p_instructions: null,
    p_results_release: 'immediate',
  })
  if (!pub.ok) throw new Error('publish failed: ' + pub.text.slice(0, 140))
  examId = pub.data.examId

  await db.query(
    `insert into public.exam_assignments (exam_id, target_kind, target_id, assigned_by)
     values ($1,'outlet',$2,(select id from public.profiles where email='sample-chef@example.com'))`,
    [examId, outletId])

  const started = await rpc(employee, 'start_attempt', { p_exam_id: examId })
  attemptId = started.data[0].attempt_id

  const sheet = (await db.query(
    `select question_id, answer_key, snapshot->>'response_format' fmt
       from public.attempt_questions where attempt_id=$1 order by position`, [attemptId])).rows

  for (const row of sheet) {
    await rpc(employee, 'save_answer', {
      p_attempt_id: attemptId, p_question_id: row.question_id,
      p_answer: row.fmt === 'choice_single'
        ? { format: 'choice_single', choice: row.answer_key.correct }
        : { format: 'text_short', text: 'Between five and sixty-three degrees.' },
    })
  }
  await rpc(employee, 'submit_attempt', { p_attempt_id: attemptId, p_reason: 'user' })

  // The literal model text this attempt carries — every leak probe searches for it.
  const models = sheet
    .filter((r) => r.fmt === 'text_short')
    .map((r) => r.answer_key?.model)
    .filter((m) => typeof m === 'string' && m.length > 2)

  console.log(`\n  ${models.length} short answer(s), model text e.g. "${models[0]}"`)
  if (models.length === 0) throw new Error('the paper carried no model answers to test with')

  const leaks = (haystack) => models.filter((m) => haystack.includes(m))

  // ── The bug 0066 fixed ───────────────────────────────────────────────────
  section('the marking view opens at all')

  const items = await rpc(chef, 'attempt_evaluation_items', { p_attempt_id: attemptId })
  check('an evaluator can open a paper-backed attempt', items.ok,
    items.ok ? '' : `${items.status} ${JSON.stringify(items.data).slice(0, 120)}`)
  check('every short answer is listed for marking',
    (items.data ?? []).length >= models.length,
    `${(items.data ?? []).length} item(s)`)

  // ── The evaluator sees it ────────────────────────────────────────────────
  section('the evaluator sees the model answer')

  const withModel = (items.data ?? []).filter((i) => i.model_answer)
  check('the model answer reaches the evaluator', withModel.length === models.length,
    `${withModel.length} of ${models.length}`)
  check('it is the text frozen onto the attempt, not re-read from the bank',
    withModel.every((i) => models.includes(i.model_answer)))
  check('the marks available are shown', (items.data ?? []).every((i) => i.marks != null))
  check('the candidate answer is shown', (items.data ?? []).some((i) => i.answer != null))

  // ── Nobody else does ─────────────────────────────────────────────────────
  section('nobody without evaluation.evaluate sees it')

  for (const [who, user] of [['a candidate', employee], ['HR', hr], ['an editor', editor]]) {
    const r = await rpc(user, 'attempt_evaluation_items', { p_attempt_id: attemptId })
    check(`${who} is refused the marking view`, !r.ok, `${r.status}`)
    check(`  …and the refusal carries no model answer`, leaks(r.text).length === 0,
      leaks(r.text).length ? 'LEAKED' : '')
  }

  const anon = await fetch(`${SUPABASE}/rest/v1/rpc/attempt_evaluation_items`, {
    method: 'POST',
    headers: { apikey: ANON, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_attempt_id: attemptId }),
  })
  const anonText = await anon.text()
  check('a signed-out caller is refused', anon.status !== 200, `${anon.status}`)
  check('  …and the refusal carries no model answer', leaks(anonText).length === 0)

  // ── Every candidate-facing surface ───────────────────────────────────────
  section('no candidate-facing surface carries it')

  const paperView = await rpc(employee, 'attempt_paper', { p_attempt_id: attemptId, p_locale: 'en' })
  check('attempt_paper carries no model answer', leaks(paperView.text).length === 0)

  const review = await rpc(employee, 'attempt_review', { p_attempt_id: attemptId })
  check('attempt_review carries no model answer', leaks(review.text).length === 0)

  const mine = await rpc(employee, 'my_attempts')
  check('my_attempts carries no model answer', leaks(mine.text).length === 0)

  const direct = await fetch(
    `${SUPABASE}/rest/v1/attempt_questions?select=answer_key&attempt_id=eq.${attemptId}`,
    { headers: { apikey: ANON, Authorization: `Bearer ${employee.token}` } })
  const directText = await direct.text()
  check('reading attempt_questions.answer_key directly returns nothing',
    directText === '[]' || !direct.ok, `${direct.status} ${directText.slice(0, 40)}`)

  const bankText = await fetch(
    `${SUPABASE}/rest/v1/bank_question_texts?select=answer_text&limit=5`,
    { headers: { apikey: ANON, Authorization: `Bearer ${employee.token}` } })
  const bankBody = await bankText.text()
  check('reading the bank answer_text directly returns nothing',
    bankBody === '[]' || !bankText.ok, `${bankText.status} ${bankBody.slice(0, 40)}`)

  // ── A candidate cannot mark ──────────────────────────────────────────────
  section('a candidate cannot mark, or alter a mark')

  const q1 = sheet.find((r) => r.fmt === 'text_short').question_id
  const selfMark = await rpc(employee, 'save_evaluation', {
    p_attempt_id: attemptId, p_question_id: q1, p_score: 1, p_note: 'full marks please',
  })
  check('a candidate cannot save an evaluation', !selfMark.ok, `${selfMark.status}`)

  const selfComplete = await rpc(employee, 'complete_evaluation', { p_attempt_id: attemptId })
  check('a candidate cannot complete an evaluation', !selfComplete.ok, `${selfComplete.status}`)

  const selfPublish = await rpc(employee, 'publish_attempt', { p_attempt_id: attemptId })
  check('a candidate cannot release their own result', !selfPublish.ok, `${selfPublish.status}`)

  const patch = await fetch(`${SUPABASE}/rest/v1/attempts?id=eq.${attemptId}`, {
    method: 'PATCH',
    headers: {
      apikey: ANON, Authorization: `Bearer ${employee.token}`,
      'Content-Type': 'application/json', Prefer: 'return=representation',
    },
    body: JSON.stringify({ score: 20, passed: true, status: 'published' }),
  })
  const patchText = await patch.text()
  check('a candidate cannot PATCH their own score', patch.status !== 200 || patchText === '[]',
    `${patch.status} ${patchText.slice(0, 60)}`)

  const [after] = (await db.query(`select score, status, passed from public.attempts where id=$1`, [attemptId])).rows
  check('the attempt row was not altered by that attempt',
    after.status === 'evaluating' && after.passed === null,
    JSON.stringify(after))

  const otherAttempt = (await db.query(
    `select id from public.attempts where id <> $1 limit 1`, [attemptId])).rows[0]
  if (otherAttempt) {
    const other = await rpc(employee, 'save_evaluation', {
      p_attempt_id: otherAttempt.id, p_question_id: q1, p_score: 1, p_note: 'x',
    })
    check("a candidate cannot mark another employee's attempt", !other.ok, `${other.status}`)
  }

  /*
   * ┌───────────────────────────────────────────────────────────────────────────┐
   * │ THE PAGE PROBES RUN BEFORE THE MARKING, NOT AFTER.                       │
   * │                                                                           │
   * │ attempt_evaluation_items() refuses an attempt that is not in `evaluating` │
   * │ or `returned`, so once the evaluation is complete /evaluate/[id] 404s for │
   * │ EVERYBODY — correctly; a marked paper is not in the queue any more.       │
   * │                                                                           │
   * │ Running these afterwards made the Chef's own row read FAIL 404 and the    │
   * │ refusals read PASS for the wrong reason, which is the more dangerous half.│
   * └───────────────────────────────────────────────────────────────────────────┘
   */
  const reachable = await fetch(`${APP}/en/login`, { redirect: 'manual' })
    .then((r) => r.ok || r.status === 307).catch(() => false)

  if (!reachable) {
    section(`direct-URL probes SKIPPED — nothing answering at ${APP}`)
  } else {
    section(`the marking page by direct URL (${APP})`)
    for (const [who, user, want] of [
      ['chef', chef, true], ['employee', employee, false],
      ['hr', hr, false], ['editor', editor, false],
    ]) {
      const res = await fetch(`${APP}/en/evaluate/${attemptId}`, {
        headers: { cookie: user.cookie }, redirect: 'manual',
      })
      const body = await res.text()
      check(`${who.padEnd(9)} ${want ? 'reaches' : 'is refused'} /evaluate/[id]`,
        (res.status === 200) === want, `${res.status}`)
      if (want) {
        check('  …and the page actually shows the model answer',
          models.some((m) => body.includes(m)))
      } else {
        check('  …and the page body carries no model answer', leaks(body).length === 0,
          leaks(body).length ? 'LEAKED' : '')
      }
    }

    const outRes = await fetch(`${APP}/en/evaluate/${attemptId}`, { redirect: 'manual' })
    const outBody = await outRes.text()
    check('signed out is redirected', outRes.status === 307 || outRes.status === 302, `${outRes.status}`)
    check('  …and gets no model answer', leaks(outBody).length === 0)
  }

  // ── The evaluator can actually mark ──────────────────────────────────────
  section('the evaluator can mark, and the result comes out')

  for (const row of sheet.filter((r) => r.fmt === 'text_short')) {
    const r = await rpc(chef, 'save_evaluation', {
      p_attempt_id: attemptId, p_question_id: row.question_id,
      p_score: 1, p_note: 'Correct in their own words.',
    })
    if (!r.ok) check('save_evaluation', false, `${r.status} ${r.text.slice(0, 120)}`)
  }

  const over = await rpc(chef, 'save_evaluation', {
    p_attempt_id: attemptId, p_question_id: q1, p_score: 99, p_note: 'too many',
  })
  check('a score above the marks available is refused', !over.ok, `${over.status}`)

  const done = await rpc(chef, 'complete_evaluation', { p_attempt_id: attemptId })
  check('the evaluation completes', done.ok, done.ok ? '' : done.text.slice(0, 140))

  await rpc(chef, 'release_due_results')
  const [final] = (await db.query(
    `select status, score, max_score, passed from public.attempts where id=$1`, [attemptId])).rows
  check('the result is released', final.status === 'published', final.status)
  check('the score counts the marked short answers',
    Number(final.score) > 0 && Number(final.score) <= Number(final.max_score),
    `${final.score} / ${final.max_score}`)
  check('a pass/fail verdict was recorded', final.passed !== null, String(final.passed))

  const reviewAfter = await rpc(employee, 'attempt_review', { p_attempt_id: attemptId })
  check('the candidate can review their released paper', reviewAfter.ok)
  check('…and it still carries no model answer', leaks(reviewAfter.text).length === 0)

} catch (err) {
  fails++
  console.error('\n  THREW: ' + err.message)
} finally {
  section('cleanup')
  try {
    if (attemptId) {
      await db.query(`delete from public.attempt_answers where attempt_id=$1`, [attemptId])
      await db.query(`delete from public.attempt_questions where attempt_id=$1`, [attemptId])
      await db.query(`delete from public.attempts where id=$1`, [attemptId])
    }
    if (examId) {
      await db.query(`delete from public.exam_assignments where exam_id=$1`, [examId])
      await db.query(`delete from public.exams where id=$1`, [examId])
    }
    if (paperId && paperWas) {
      await db.query(
        `update public.exam_papers set status=$2, status_changed_at=$3, status_changed_by=$4 where id=$1`,
        [paperId, paperWas.status, paperWas.at, paperWas.by])
    }
    console.log('  exam and attempt removed, paper status restored')
  } catch (e) {
    console.error('  cleanup problem: ' + e.message)
  }
  await db.end()
}

console.log(fails === 0 ? '\n  ALL CHECKS PASSED\n' : `\n  ${fails} CHECK(S) FAILED\n`)
process.exitCode = fails ? 1 : 0
