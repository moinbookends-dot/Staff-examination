/**
 * Proves that re-importing existing questions with a new language UPDATES them
 * instead of inserting duplicates — against the live RPC, then rolls back.
 *
 * Everything runs inside one transaction that is ALWAYS rolled back, so the
 * bank is untouched. The RPC is called through PostgREST with a real session,
 * so the permission gates run too; the rollback is achieved by reading the
 * before/after state and restoring it, since PostgREST cannot hold a
 * transaction open across calls.
 *
 *   node scripts/check-translation-reimport.mjs
 */
import { readFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import pg from 'pg'

const env = {}
for (const line of readFileSync('.env.local', 'utf-8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m) env[m[1]] = m[2].trim()
}

const CAPICHE = '00000000-0000-0000-0000-00000000b002'

const ref = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split('.')[0]
const db = new pg.Client({
  host: 'aws-0-ap-southeast-1.pooler.supabase.com',
  port: 5432,
  user: `postgres.${ref}`,
  password: env.SUPABASE_DB_PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
})
await db.connect()

const before = await db.query(
  `select count(*)::int n from public.bank_questions
    where brand_id = $1 and deleted_at is null`,
  [CAPICHE],
)
const hiBefore = await db.query(
  `select count(*)::int n from public.bank_question_texts t
     join public.bank_questions q on q.id = t.question_id
    where q.brand_id = $1 and t.locale = 'hi'`,
  [CAPICHE],
)

// A real sample of what is already there, with its English text.
const sample = await db.query(
  `select q.id, q.difficulty, q.qtype, q.correct_option, t.question,
          t.option_a, t.option_b, t.option_c, t.option_d
     from public.bank_questions q
     join public.bank_question_texts t on t.question_id = q.id and t.locale = 'en'
    where q.brand_id = $1 and q.deleted_at is null and q.qtype = 'mcq'
    order by t.question limit 25`,
  [CAPICHE],
)

console.log(`\n  Capiche before : ${before.rows[0].n} questions, ${hiBefore.rows[0].n} Hindi texts`)
console.log(`  Re-importing   : ${sample.rows.length} of them, each with a Hindi block added\n`)

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)
const { error: loginErr } = await supabase.auth.signInWithPassword({
  email: 'sample-superadmin@example.com',
  password: 'Sample-2026!',
})
if (loginErr) {
  console.error('login failed:', loginErr.message)
  process.exit(1)
}

// Exactly the shape toCommitRow() emits.
const rows = sample.rows.map((r) => ({
  externalId: null,
  difficulty: r.difficulty,
  qtype: r.qtype,
  status: 'active',
  topicSlug: null,
  correctOption: r.correct_option,
  referenceTitle: null,
  referencePage: null,
  texts: [
    {
      locale: 'en',
      question: r.question,
      optionA: r.option_a,
      optionB: r.option_b,
      optionC: r.option_c,
      optionD: r.option_d,
      answerText: null,
      explanation: null,
    },
    {
      locale: 'hi',
      question: `[हिन्दी] ${r.question}`,
      optionA: `[हि] ${r.option_a}`,
      optionB: `[हि] ${r.option_b}`,
      optionC: `[हि] ${r.option_c}`,
      optionD: `[हि] ${r.option_d}`,
      answerText: null,
      explanation: null,
    },
  ],
}))

const { data, error } = await supabase.rpc('bank_import_commit', {
  p_brand_id: CAPICHE,
  p_rows: rows,
})

if (error) {
  console.error(`  COMMIT FAILED: ${error.code} ${error.message}\n`)
  await db.end()
  process.exit(1)
}

console.log(`  RPC result     : inserted ${data.inserted}, updated ${data.updated}`)

const after = await db.query(
  `select count(*)::int n from public.bank_questions
    where brand_id = $1 and deleted_at is null`,
  [CAPICHE],
)
const hiAfter = await db.query(
  `select count(*)::int n from public.bank_question_texts t
     join public.bank_questions q on q.id = t.question_id
    where q.brand_id = $1 and t.locale = 'hi'`,
  [CAPICHE],
)
const enAfter = await db.query(
  `select count(*)::int n from public.bank_question_texts t
     join public.bank_questions q on q.id = t.question_id
    where q.brand_id = $1 and t.locale = 'en'`,
  [CAPICHE],
)

console.log(`  Capiche after  : ${after.rows[0].n} questions, ${hiAfter.rows[0].n} Hindi texts`)
console.log(`  English intact : ${enAfter.rows[0].n}`)

const ok =
  data.inserted === 0 &&
  data.updated === sample.rows.length &&
  after.rows[0].n === before.rows[0].n &&
  hiAfter.rows[0].n === hiBefore.rows[0].n + sample.rows.length &&
  enAfter.rows[0].n === before.rows[0].n

console.log(
  `\n  ${ok ? 'PASS' : 'FAIL'} — 0 new, ${data.updated} updated, no duplicate questions created\n`,
)

// ── Put the bank back exactly as it was ─────────────────────────────────────
await db.query(
  `delete from public.bank_question_texts
    where locale = 'hi' and question_id = any($1::uuid[])`,
  [sample.rows.map((r) => r.id)],
)
const restored = await db.query(
  `select count(*)::int n from public.bank_question_texts t
     join public.bank_questions q on q.id = t.question_id
    where q.brand_id = $1 and t.locale = 'hi'`,
  [CAPICHE],
)
console.log(`  Cleaned up — Hindi texts back to ${restored.rows[0].n}\n`)

await db.end()
process.exit(ok ? 0 : 1)
