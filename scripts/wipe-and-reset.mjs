/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Clear the sample dataset so a real question bank can take its place.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THIS IS IRREVERSIBLE AND IT IS NOT A DEVELOPMENT CONVENIENCE.             ║
 * ║                                                                           ║
 * ║ It destroys the question bank, every generated paper, every exam, and     ║
 * ║ every attempt and result. There is no soft-delete path back: attempts and ║
 * ║ papers are removed outright, not flagged.                                 ║
 * ║                                                                           ║
 * ║ It runs in DRY RUN unless --apply is passed, and --apply additionally     ║
 * ║ requires --i-understand-this-deletes-everything. Two flags, because one   ║
 * ║ flag is something you can type by accident while reaching for history.    ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE ORDER IS DICTATED BY FOUR `RESTRICT` FOREIGN KEYS, NOT BY TASTE.      │
 * │                                                                           │
 * │   exam_paper_questions.question_id -> bank_questions   RESTRICT           │
 * │   exams.paper_id                   -> exam_papers      RESTRICT           │
 * │   attempts.exam_id                 -> exams            RESTRICT           │
 * │   bank_questions.topic_id          -> question_topics  RESTRICT           │
 * │                                                                           │
 * │ So the bank cannot go first, however much it looks like the root of the   │
 * │ tree. Attempts, then exams, then papers, then the bank. Everything else   │
 * │ (answers, assignments, sections, texts, files) is ON DELETE CASCADE and   │
 * │ disappears with its parent — those are counted below but never deleted    │
 * │ directly, so the counts prove the cascade did what it claims.             │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 *   node scripts/wipe-and-reset.mjs                 # dry run, changes nothing
 *   node scripts/wipe-and-reset.mjs --apply --i-understand-this-deletes-everything
 *
 * Options:
 *   --keep-topics   leave question_topics alone (default: keep)
 *   --drop-topics   delete the 14 sample topics as well
 *   --keep-legacy   leave public.questions (the 9-format legacy bank) alone
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'

const APPLY =
  process.argv.includes('--apply') &&
  process.argv.includes('--i-understand-this-deletes-everything')
const DROP_TOPICS = process.argv.includes('--drop-topics')
const KEEP_LEGACY = process.argv.includes('--keep-legacy')

if (process.argv.includes('--apply') && !APPLY) {
  console.error('\n  --apply also requires --i-understand-this-deletes-everything\n')
  process.exit(2)
}

const env = {}
for (const line of readFileSync(resolve('.env.local'), 'utf-8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m) env[m[1]] = m[2].trim()
}
const ref = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split('.')[0]

const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST ?? 'aws-0-ap-southeast-1.pooler.supabase.com',
  port: 5432,
  user: `postgres.${ref}`,
  password: env.SUPABASE_DB_PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
})

/** Parent tables, in the only order the RESTRICT constraints permit. */
const PLAN = [
  { table: 'attempts', why: 'cascades answers, questions, verifications' },
  { table: 'exams', why: 'cascades assignments, exam_questions, exam_sections' },
  { table: 'exam_papers', why: 'cascades paper_questions and paper_files' },
  { table: 'bank_questions', why: 'cascades bank_question_texts' },
]

/** Counted to prove the cascade did its job; never deleted directly. */
const CASCADED = [
  'attempt_answers',
  'attempt_questions',
  'attempt_verifications',
  'exam_assignments',
  'exam_questions',
  'exam_sections',
  'exam_paper_questions',
  'exam_paper_files',
  'bank_question_texts',
]

const count = async (t) => (await db.query(`select count(*)::int n from public.${t}`)).rows[0].n

try {
  await db.connect()

  console.log(`\n  ${APPLY ? '*** APPLYING — THIS DELETES DATA ***' : 'DRY RUN — nothing will be changed'}\n`)

  const before = {}
  for (const t of [...PLAN.map((p) => p.table), ...CASCADED, 'question_topics', 'questions']) {
    before[t] = await count(t)
  }

  console.log('  Deleted directly, in this order:\n')
  for (const { table, why } of PLAN) {
    console.log(`    ${String(before[table]).padStart(6)}  ${table.padEnd(22)} ${why}`)
  }

  console.log('\n  Removed by ON DELETE CASCADE:\n')
  for (const t of CASCADED) console.log(`    ${String(before[t]).padStart(6)}  ${t}`)

  console.log('\n  Left alone:\n')
  console.log(`    ${String(before.question_topics).padStart(6)}  question_topics   ${DROP_TOPICS ? '← --drop-topics given, WILL be deleted' : '(the new bank needs topics to attach to)'}`)
  console.log(`    ${String(before.questions).padStart(6)}  questions         ${KEEP_LEGACY ? '(--keep-legacy)' : '← legacy 9-format bank, WILL be deleted'}`)
  console.log('           profiles, roles, outlets, brands, companies — untouched')

  if (!APPLY) {
    console.log('\n  Nothing was changed. Re-run with:')
    console.log('    node scripts/wipe-and-reset.mjs --apply --i-understand-this-deletes-everything\n')
    await db.end()
    process.exit(0)
  }

  /*
   * One transaction. A wipe that half-applies is the worst outcome available:
   * papers gone, bank intact, and no way to tell from the app which half ran.
   */
  await db.query('begin')

  const deleted = {}
  for (const { table } of PLAN) {
    const res = await db.query(`delete from public.${table}`)
    deleted[table] = res.rowCount
  }

  if (!KEEP_LEGACY) {
    // The pre-0053 question bank. Nothing in the current product reads it.
    await db.query('delete from public.questions')
  }
  if (DROP_TOPICS) {
    await db.query('delete from public.question_topics')
  }

  /*
   * Paper numbering restarts at 1.
   *
   * current_epoch is NOT reset. It is what makes the combination hash unique
   * across a bank change: leaving it alone means a paper generated from the
   * new bank can never collide with the hash of a paper from the old one, even
   * if the two drew the same question ids — which they cannot, but the guard
   * costs nothing and removing it would be silently unsafe.
   */
  await db.query('update public.paper_counters set next_paper_no = 1, updated_at = now()')

  /*
   * Notifications and queued mail about exams that no longer exist.
   * Scoped to the two kinds this system generates for exams and results, so
   * account notifications (approved / rejected) survive.
   */
  const notif = await db.query(
    `delete from public.notifications where kind in ('exam.assigned','result.published')`,
  )
  const mail = await db.query(
    `delete from public.email_outbox where template in ('exam-assigned','result-published')`,
  )

  await db.query('commit')

  console.log('\n  Applied:\n')
  for (const { table } of PLAN) console.log(`    ${String(deleted[table]).padStart(6)}  ${table}`)
  console.log(`    ${String(notif.rowCount).padStart(6)}  notifications (exam/result only)`)
  console.log(`    ${String(mail.rowCount).padStart(6)}  email_outbox (exam/result only)`)

  const after = {}
  for (const t of [...PLAN.map((p) => p.table), ...CASCADED]) after[t] = await count(t)
  const leftover = Object.entries(after).filter(([, n]) => n > 0)

  console.log('')
  if (leftover.length === 0) {
    console.log('  Every table is empty — the cascades did what they claimed.\n')
  } else {
    console.log('  STILL POPULATED — investigate before importing:')
    for (const [t, n] of leftover) console.log(`    ${String(n).padStart(6)}  ${t}`)
    console.log('')
    process.exitCode = 1
  }

  console.log('  Paper numbering restarts at 1.')
  console.log('  NOTE: with no short-answer questions, paper generation will refuse')
  console.log('        until short answers exist. That was the accepted trade.\n')
} catch (error) {
  try {
    await db.query('rollback')
    console.error('\n  ROLLED BACK — no changes were made.')
  } catch {
    /* the transaction never opened */
  }
  console.error(`\n  ${error.message}\n`)
  process.exitCode = 1
} finally {
  await db.end()
}
