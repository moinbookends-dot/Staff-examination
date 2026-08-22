/** READ-ONLY. Which migrations the remote history records, and what actually exists. */
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

const { rows: applied } = await db.query(
  `select version, name from supabase_migrations.schema_migrations order by version`,
)
console.log('\n  RECORDED AS APPLIED:')
for (const r of applied) console.log(`    ${r.version}  ${r.name ?? ''}`)

const { rows: counts } = await db.query(`
  select
    (select count(*)::int from information_schema.tables where table_schema='public') as tables,
    (select count(*)::int from information_schema.routines where routine_schema='public') as functions,
    (select count(*)::int from pg_policies where schemaname='public') as policies
`)
console.log(`\n  ACTUAL SCHEMA: ${counts[0].tables} tables, ${counts[0].functions} functions, ${counts[0].policies} policies`)

// Spot-check objects created by migrations the history does NOT record.
const probes = [
  ['0014 exams', `select to_regclass('public.exams') is not null as x`],
  ['0025 attempts', `select to_regclass('public.attempts') is not null as x`],
  // 0068 dropped source_documents with the rest of the Guide, so this probe is
  // inverted: it must now report ABSENT. Left in rather than deleted because a
  // table reappearing is exactly the kind of thing a probe list exists to catch.
  ['0068 source_documents (must be ABSENT)', `select to_regclass('public.source_documents') is not null as x`],
  // Dropped by 0068 alongside the Guide: `jobs` was the queue for AI question
  // generation, which is not how questions are made any more. Inverted like
  // source_documents above rather than deleted — a table coming back is worth
  // seeing.
  ['0068 jobs (must be ABSENT)', `select to_regclass('public.jobs') is not null as x`],
  ['0052 difficulty_levels', `select to_regclass('public.difficulty_levels') is not null as x`],
  ['0053 bank_questions (NEW)', `select to_regclass('public.bank_questions') is not null as x`],
  ['0056 exam_papers (NEW)', `select to_regclass('public.exam_papers') is not null as x`],
]
console.log('\n  OBJECT PROBES:')
for (const [label, sql] of probes) {
  const { rows } = await db.query(sql)
  console.log(`    ${rows[0].x ? 'EXISTS  ' : 'absent  '}${label}`)
}

await db.end()
console.log('')
