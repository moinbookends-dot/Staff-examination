/**
 * ═════════════════════════════════════════════════════════════════════════════
 * EDITING A GENERATED PAPER — WHAT IS ALLOWED, AND EVERYTHING THAT IS NOT.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THIS FEATURE CAN CORRUPT AN EXAM IN WAYS NOTHING ELSE IN THE PRODUCT CAN. ║
 * ║                                                                           ║
 * ║ Until 0072 the question list of a paper was written exactly once, by the  ║
 * ║ generator, and never touched again. Every guarantee downstream — the      ║
 * ║ 80/20 split, one mark per question, no repeats, never the same paper      ║
 * ║ twice — rested on that. Opening the list to a browser puts all of them    ║
 * ║ within reach of a crafted request, so each one is probed here as a REAL   ║
 * ║ HTTP call with a real token, not asserted from the SQL.                   ║
 * ║                                                                           ║
 * ║ The most important assertion in this file is the last one: a paper that   ║
 * ║ has been published CANNOT be edited. start_attempt copies the questions   ║
 * ║ at ATTEMPT START, so a successful edit there would give later candidates  ║
 * ║ a different paper from earlier ones in the same sitting — silently, with  ║
 * ║ both sets marked against the same key.                                    ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Restores the paper it borrows, in `finally`, whatever happened.
 *
 *   node scripts/check-paper-edit.mjs
 * ═════════════════════════════════════════════════════════════════════════════
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'
import { claimEditablePaper } from './free-paper.mjs'

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
  return { token: s.access_token }
}

async function rpc(user, fn, args) {
  const res = await fetch(`${SUPABASE}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${user.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args ?? {}),
  })
  const text = await res.text()
  let body
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  return res.ok ? { ok: true, data: body } : { ok: false, error: body, status: res.status }
}

let paperId = null
let originalList = null
let originalHash = null
const madeExams = []

try {
  await db.connect()

  const admin = await signIn('sample-chef@example.com')
  const employee = await signIn('sample-employee@example.com')
  const hr = await signIn('sample-hr@example.com')

  // EDITABLE, not merely free. A once-published paper keeps the 'live' status
  // for good — set_paper_status refuses to return anything to 'generated' —
  // so claimFreePaper would hand back a paper this feature cannot touch.
  const paper = await claimEditablePaper(db)
  paperId = paper.id

  // Everything needed to put the paper back exactly as it was.
  originalList = (await db.query(
    'select question_id, question_no, section from public.exam_paper_questions where paper_id=$1 order by question_no',
    [paperId],
  )).rows
  originalHash = (await db.query(
    "select encode(combination_hash,'hex') h from public.exam_papers where id=$1", [paperId],
  )).rows[0].h

  console.log(`\n  Paper #${paper.paper_no} — ${paper.marks} marks (${paper.mcq_n} MCQ + ${paper.short_n} short)`)

  const asList = (rows) =>
    rows.map((r) => ({ questionId: r.question_id, questionNo: r.question_no, section: r.section }))

  // ── Who may edit ─────────────────────────────────────────────────────────
  section('who may edit a paper')

  for (const [who, user] of [['a candidate', employee], ['HR', hr]]) {
    const r = await rpc(user, 'edit_paper_questions', {
      p_paper_id: paperId, p_questions: asList(originalList),
    })
    check(`${who} cannot edit a paper`, !r.ok, `${r.status}`)
  }

  const reviewEmp = await rpc(employee, 'paper_review_questions', { p_paper_id: paperId })
  check('a candidate cannot even read the paper for review', !reviewEmp.ok, `${reviewEmp.status}`)

  // ── Reading it ───────────────────────────────────────────────────────────
  section('the review view')

  const review = await rpc(admin, 'paper_review_questions', { p_paper_id: paperId })
  check('an admin can read the paper for review', review.ok, review.ok ? '' : JSON.stringify(review.error).slice(0, 90))
  check('it returns every question', (review.data ?? []).length === originalList.length,
    `${(review.data ?? []).length} of ${originalList.length}`)
  check('each carries the id the editor needs', (review.data ?? []).every((q) => q.question_id))
  check('and the question text', (review.data ?? []).every((q) => typeof q.question === 'string'))

  /*
   * THE LEAK PROBE. The review view exists to let somebody judge a paper, not
   * to hand them the answers — an admin holds bank.read and could look them up
   * deliberately, but this payload must not volunteer them.
   */
  const reviewText = JSON.stringify(review.data ?? [])
  for (const forbidden of ['correct_option', 'answer_text', 'model_answer', 'correctOption']) {
    check(`the review view carries no ${forbidden}`, !reviewText.includes(forbidden))
  }

  // ── The picker ───────────────────────────────────────────────────────────
  section('the replacement picker')

  const onPaper = new Set(originalList.map((r) => r.question_id))

  const pick = await rpc(admin, 'paper_eligible_questions', {
    p_paper_id: paperId, p_qtype: 'mcq', p_limit: 50,
  })
  check('an admin can list eligible questions', pick.ok, pick.ok ? '' : JSON.stringify(pick.error).slice(0, 90))
  check('it offers only MCQs when asked for MCQs',
    (pick.data ?? []).every((q) => q.qtype === 'mcq'))
  check('it never offers a question already on the paper',
    (pick.data ?? []).every((q) => !onPaper.has(q.question_id)),
    `${(pick.data ?? []).filter((q) => onPaper.has(q.question_id)).length} already on the paper`)

  const pickText = JSON.stringify(pick.data ?? [])
  for (const forbidden of ['correct_option', 'answer_text', 'model_answer']) {
    check(`the picker carries no ${forbidden}`, !pickText.includes(forbidden))
  }

  const pickEmp = await rpc(employee, 'paper_eligible_questions', { p_paper_id: paperId })
  check('a candidate cannot open the picker', !pickEmp.ok, `${pickEmp.status}`)

  // ── A real replacement ───────────────────────────────────────────────────
  section('replacing one question')

  const replacement = (pick.data ?? [])[0]
  if (!replacement) throw new Error('no eligible MCQ to swap in — seed a larger bank')

  const targetIndex = originalList.findIndex((r) => r.section === 'mcq')
  const edited = asList(originalList)
  const removedId = edited[targetIndex].questionId
  edited[targetIndex] = { ...edited[targetIndex], questionId: replacement.question_id }

  const saved = await rpc(admin, 'edit_paper_questions', { p_paper_id: paperId, p_questions: edited })
  check('the edit is accepted', saved.ok, saved.ok ? '' : JSON.stringify(saved.error).slice(0, 120))

  const after = (await db.query(
    'select question_id, question_no, section from public.exam_paper_questions where paper_id=$1 order by question_no',
    [paperId],
  )).rows
  check('the paper still holds the right number of questions', after.length === originalList.length)
  check('the new question is on it', after.some((r) => r.question_id === replacement.question_id))
  check('the old one is gone', !after.some((r) => r.question_id === removedId))

  const newHash = (await db.query(
    "select encode(combination_hash,'hex') h from public.exam_papers where id=$1", [paperId],
  )).rows[0].h
  check('the combination fingerprint was recomputed', newHash !== originalHash,
    'without this the never-twice index would describe questions the paper no longer holds')

  /*
   * The hash must equal what the JS generator would compute for the same set,
   * or the editor and the generator hold two different notions of "the same
   * paper" and the never-twice rule protects nothing.
   *
   * GUARDED ON THE EDIT HAVING HAPPENED. An earlier run reported this as a
   * PASS while the edit itself had been refused — the paper was untouched, so
   * of course its stored hash still matched its own questions. A check that
   * passes hardest when nothing happened is worse than no check.
   */
  if (saved.ok) {
    const { createHash } = await import('node:crypto')
    const expected = createHash('sha256')
      .update([...after.map((r) => r.question_id)].sort().join('\n'), 'utf8')
      .digest('hex')
    check('and it matches what the generator would compute', newHash === expected,
      `${newHash.slice(0, 16)}… vs ${expected.slice(0, 16)}…`)
  } else {
    check('and it matches what the generator would compute', false,
      'SKIPPED — the edit above was refused, so this would have passed vacuously')
  }

  // ── Reordering ───────────────────────────────────────────────────────────
  section('reordering')

  const reversed = after
    .map((r, i) => ({ questionId: r.question_id, questionNo: after.length - i, section: r.section }))
  const reorder = await rpc(admin, 'edit_paper_questions', { p_paper_id: paperId, p_questions: reversed })
  check('a full reorder is accepted', reorder.ok, reorder.ok ? '' : JSON.stringify(reorder.error).slice(0, 120))

  const hashAfterReorder = (await db.query(
    "select encode(combination_hash,'hex') h from public.exam_papers where id=$1", [paperId],
  )).rows[0].h
  check('reordering does NOT change the fingerprint',
    hashAfterReorder === newHash,
    'the hash is over a SET — two orderings of the same questions are the same paper')

  // ── Everything that must be refused ──────────────────────────────────────
  section('what the database refuses')

  const base = (await db.query(
    'select question_id, question_no, section from public.exam_paper_questions where paper_id=$1 order by question_no',
    [paperId],
  )).rows

  const refusals = [
    ['a question removed without replacement', asList(base).slice(0, -1)],
    ['the same question twice', asList(base).map((q, i) => (i === 1 ? { ...q, questionId: base[0].question_id } : q))],
    ['a gap in the numbering', asList(base).map((q, i) => (i === 0 ? { ...q, questionNo: 99 } : q))],
    /*
     * A REAL type mismatch, using a VALID enum label.
     *
     * This sent 'short', which is not a bank_question_type at all — so the
     * refusal it observed was a 22P02 cast error, not the composition check
     * it meant to exercise. It would have passed even if that check were
     * deleted. 'short_answer' is the real label, so the paper now genuinely
     * claims 20 short answers where the blueprint wants 16 MCQ + 4.
     */
    ['an MCQ slot relabelled as a short answer',
      asList(base).map((q) => (q.section === 'mcq' ? { ...q, section: 'short_answer' } : q))],
    ['a question that is not in the bank',
      asList(base).map((q, i) => (i === 0 ? { ...q, questionId: '00000000-0000-0000-0000-0000000000ff' } : q))],
    ['an empty paper', []],
  ]

  for (const [label, payload] of refusals) {
    const r = await rpc(admin, 'edit_paper_questions', { p_paper_id: paperId, p_questions: payload })
    check(`refused: ${label}`, !r.ok, r.ok ? 'ACCEPTED' : `${r.status}`)
  }

  // And nothing above changed the paper.
  const unchanged = (await db.query(
    'select count(*)::int n from public.exam_paper_questions where paper_id=$1', [paperId],
  )).rows[0].n
  check('every refusal left the paper intact', unchanged === base.length, `${unchanged} of ${base.length}`)

  // ── The one that matters most ────────────────────────────────────────────
  section('a published paper is frozen')

  const editableBefore = (await db.query('select public.paper_is_editable($1) e', [paperId])).rows[0].e
  check('the paper is editable while unpublished', editableBefore === true)

  const published = await rpc(admin, 'publish_paper_as_exam', {
    p_paper_id: paperId,
    p_title: 'Paper edit check',
    p_duration_minutes: 30,
    p_opens_at: null,
    p_closes_at: new Date(Date.now() + 2 * 3600_000).toISOString(),
    p_max_attempts: 1,
    p_pass_mark_percent: 60,
    p_instructions: null,
    p_results_release: 'immediate',
  })
  check('the paper publishes', published.ok, published.ok ? '' : JSON.stringify(published.error).slice(0, 120))
  if (published.ok) madeExams.push(published.data.examId)

  const editableAfter = (await db.query('select public.paper_is_editable($1) e', [paperId])).rows[0].e
  check('it stops being editable the moment an exam exists', editableAfter === false)

  const afterPublish = await rpc(admin, 'edit_paper_questions', {
    p_paper_id: paperId, p_questions: asList(base),
  })
  check('EDITING A PUBLISHED PAPER IS REFUSED', !afterPublish.ok,
    afterPublish.ok ? 'A LIVE PAPER WAS EDITED' : `${afterPublish.status}`)
} catch (err) {
  fails++
  console.error('\n  THREW: ' + err.message)
} finally {
  section('cleanup')
  try {
    for (const examId of madeExams) {
      await db.query('delete from public.exam_assignments where exam_id=$1', [examId])
      await db.query('delete from public.exams where id=$1', [examId])
    }
    if (paperId && originalList) {
      await db.query('delete from public.exam_paper_questions where paper_id=$1', [paperId])
      for (const r of originalList) {
        await db.query(
          'insert into public.exam_paper_questions (paper_id, question_id, question_no, section) values ($1,$2,$3,$4)',
          [paperId, r.question_id, r.question_no, r.section],
        )
      }
      await db.query("update public.exam_papers set combination_hash = decode($2,'hex'), status='generated' where id=$1",
        [paperId, originalHash])
      console.log('  paper restored to its original questions, order and fingerprint')
    }
  } catch (e) {
    fails++
    console.error('  CLEANUP FAILED: ' + e.message)
  }
  await db.end()
}

console.log(fails === 0 ? '\n  ALL CHECKS PASSED\n' : `\n  ${fails} CHECK(S) FAILED\n`)
process.exitCode = fails ? 1 : 0
