/** READ-ONLY. Verify the rows migrations 0053/0056 seed, and the new constraints. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'

const env = Object.fromEntries(
  readFileSync(resolve('.env.local'), 'utf-8')
    .split(/\r?\n/)
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/))
    .filter(Boolean)
    .map((m) => [m[1], m[2].trim()]),
)
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

const one = async (sql) => (await db.query(sql)).rows

console.log('\n  SEEDED BY MIGRATION:')
const topics = await one(`select name from public.question_topics order by sort_order`)
console.log(`    question_topics   ${topics.length}: ${topics.map((t) => t.name).join(', ')}`)

const settings = await one(`select marks, mcq_n, short_n from public.paper_settings order by marks`)
console.log(`    paper_settings    ${settings.map((s) => `${s.marks}=${s.mcq_n}+${s.short_n}`).join(', ')}`)

const exam = await one(`select required_locales, label_easy, label_medium, label_hard from public.exam_settings`)
console.log(`    exam_settings     required=${JSON.stringify(exam[0]?.required_locales)} labels=${exam[0]?.label_easy}/${exam[0]?.label_medium}/${exam[0]?.label_hard}`)

const counters = await one(`select next_paper_no, current_epoch from public.paper_counters`)
console.log(`    paper_counters    next_paper_no=${counters[0]?.next_paper_no} epoch=${counters[0]?.current_epoch}`)

console.log('\n  THE 80/20 CONSTRAINT (should REFUSE a bad split):')
try {
  await db.query('begin')
  await db.query(
    `insert into public.paper_settings (company_id, marks, mcq_n, short_n)
     select id, 30, 15, 15 from public.companies limit 1`,
  )
  console.log('    FAIL — a 15+15 split for 30 marks was ACCEPTED')
} catch (err) {
  console.log(`    ok — refused (${err.code}: ${String(err.message).slice(0, 60)}…)`)
} finally {
  await db.query('rollback')
}

console.log('\n  KEY CONSTRAINTS ON bank_questions:')
const cons = await one(`
  select conname from pg_constraint
   where conrelid = 'public.bank_questions'::regclass and contype = 'c'
   order by conname`)
for (const c of cons) console.log(`    · ${c.conname}`)

const idx = await one(`
  select indexname from pg_indexes
   where tablename = 'bank_question_texts' and indexname like '%dedupe%'`)
console.log(`\n  duplicate-refusal index: ${idx.map((i) => i.indexname).join(', ') || 'MISSING'}`)

console.log('\n  RLS ENABLED:')
const rls = await one(`
  select relname, relrowsecurity from pg_class
   where relname in ('bank_questions','bank_question_texts','exam_papers','question_topics','exam_settings')
   order by relname`)
for (const r of rls) console.log(`    ${r.relrowsecurity ? 'on ' : 'OFF'} ${r.relname}`)

await db.end()
console.log('')
