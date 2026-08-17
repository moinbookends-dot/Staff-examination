/**
 * Generate one paper from the imported bank, the way the app does.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHY THIS EXISTS: THE WIPE REMOVED THE FIXTURE THREE CHECKS DEPEND ON.    │
 * │                                                                           │
 * │ check-delivery, check-live-exams and check-marking all begin by claiming  │
 * │ an unpublished paper. With every paper deleted they fail with "no free    │
 * │ paper after 30s" — not a regression, an empty fixture. One real paper     │
 * │ restores them, and generating it is also the last unproven step of the    │
 * │ pipeline: bank → draw → hash → save.                                      │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Mirrors src/server/papers/repository.ts exactly:
 *   bank_draw_question_ids per type → sha256 of the SORTED ids → save_exam_paper
 *
 *   node scripts/generate-first-paper.mjs --apply
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'

const APPLY = process.argv.includes('--apply')

const env = {}
for (const line of readFileSync(resolve('.env.local'), 'utf-8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m) env[m[1]] = m[2].trim()
}
const U = env.NEXT_PUBLIC_SUPABASE_URL
const ANON = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
const ref = new URL(U).hostname.split('.')[0]

const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST ?? 'aws-0-ap-southeast-1.pooler.supabase.com',
  port: 5432,
  user: `postgres.${ref}`,
  password: env.SUPABASE_DB_PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
})

const rpc = async (token, fn, body) => {
  const res = await fetch(`${U}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: { apikey: ANON, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

try {
  await db.connect()

  const s = await (
    await fetch(`${U}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'sample-chef@example.com', password: 'Sample-2026!' }),
    })
  ).json()
  const token = s.access_token
  if (!token) throw new Error('could not sign in as an administrator')

  const [brand] = (await db.query(`select id, name from public.brands where slug = 'aiko'`)).rows
  const [counter] = (await db.query(`select current_epoch from public.paper_counters limit 1`)).rows

  const draw = async (qtype, count) => {
    const r = await rpc(token, 'bank_draw_question_ids', {
      p_brand_id: brand.id,
      p_difficulty: 'easy',
      p_qtype: qtype,
      p_count: count,
    })
    if (r.status !== 200) throw new Error(`draw ${qtype} failed: ${JSON.stringify(r.body)}`)
    return r.body.map((row) => row.id)
  }

  const mcqIds = await draw('mcq', 16)
  const shortIds = await draw('short_answer', 4)

  console.log(`\n  brand        ${brand.name}`)
  console.log(`  drew         ${mcqIds.length} mcq + ${shortIds.length} short`)

  if (mcqIds.length !== 16 || shortIds.length !== 4) {
    throw new Error('the bank could not fill a 20-mark paper')
  }

  /*
   * The questions in paper order: MCQs 1–16, short answers 17–20.
   * The HASH, though, is over the ids SORTED — so reordering a paper cannot
   * make it look like a different one. paper-hash.ts is the single definition
   * and this mirrors it exactly rather than inventing a second recipe.
   */
  const questions = [
    ...mcqIds.map((id, i) => ({ questionId: id, questionNo: i + 1, section: 'mcq' })),
    ...shortIds.map((id, i) => ({ questionId: id, questionNo: 17 + i, section: 'short_answer' })),
  ]
  const hash = createHash('sha256')
    .update([...mcqIds, ...shortIds].sort().join('\n'), 'utf8')
    .digest('hex')

  console.log(`  hash         ${hash.slice(0, 24)}…`)

  if (!APPLY) {
    console.log('\n  Dry run. Re-run with --apply\n')
    await db.end()
    process.exit(0)
  }

  const saved = await rpc(token, 'save_exam_paper', {
    p_brand_id: brand.id,
    p_difficulty: 'easy',
    p_marks: 20,
    p_mcq_n: 16,
    p_short_n: 4,
    p_epoch: counter.current_epoch,
    // bytea over PostgREST is hex with a leading \x — not base64.
    p_combination_hash: `\\x${hash}`,
    p_questions: questions,
  })

  if (saved.status !== 200) throw new Error(`save failed (${saved.status}): ${JSON.stringify(saved.body)}`)
  console.log(`  saved        ${JSON.stringify(saved.body)}`)

  console.log('\n  In the database now\n')
  console.table(
    (
      await db.query(`
        select p.paper_no, p.difficulty, p.marks, p.status,
               count(*) filter (where e.section = 'mcq')::int mcq,
               count(*) filter (where e.section = 'short_answer')::int short
          from public.exam_papers p
          join public.exam_paper_questions e on e.paper_id = p.id
         group by p.id, p.paper_no, p.difficulty, p.marks, p.status
         order by p.paper_no`)
    ).rows,
  )
  console.log('')
} catch (error) {
  console.error(`\n  ${error.message}\n`)
  process.exitCode = 1
} finally {
  await db.end()
}
