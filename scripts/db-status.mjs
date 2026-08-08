/**
 * READ-ONLY database inspection. Writes nothing, changes nothing.
 *
 * Answers three questions before anybody runs `supabase db push`:
 *   1. Can this machine reach the database at all?
 *   2. Which migrations does the remote history say are applied?
 *   3. Which local migration files have no matching remote row?
 *
 * Every statement below is a SELECT. There is no DDL, no INSERT, no UPDATE.
 *
 *   node scripts/db-status.mjs
 */

import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'

function readEnvLocal() {
  const raw = readFileSync(resolve('.env.local'), 'utf-8')
  const out = {}
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) out[m[1]] = m[2].trim()
  }
  return out
}

const env = readEnvLocal()
const ref = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split('.')[0]

const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST ?? 'aws-0-ap-southeast-1.pooler.supabase.com',
  port: 5432,
  user: `postgres.${ref}`,
  password: env.SUPABASE_DB_PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
})

console.log('')
try {
  await db.connect()
  console.log('  CONNECTION   ok (pooler, as postgres.' + ref + ')')
} catch (err) {
  console.log(`  CONNECTION   FAILED — ${err.message}`)
  process.exit(1)
}

const { rows: version } = await db.query('show server_version')
console.log(`  POSTGRES     ${version[0].server_version}`)

// ── Applied migrations, per the remote history table ────────────────────────
let applied = []
try {
  const { rows } = await db.query(
    `select version, name from supabase_migrations.schema_migrations order by version`,
  )
  applied = rows
} catch (err) {
  console.log(`\n  MIGRATION HISTORY  unreadable — ${err.message}`)
  console.log('  (a first push would create supabase_migrations.schema_migrations)')
}

const local = readdirSync(resolve('supabase/migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort()

const appliedVersions = new Set(applied.map((r) => r.version))
const localVersions = local.map((f) => ({ file: f, version: f.split('_')[0] }))

const pending = localVersions.filter((l) => !appliedVersions.has(l.version))
const orphans = applied.filter((a) => !localVersions.some((l) => l.version === a.version))

console.log(`\n  LOCAL FILES  ${local.length}`)
console.log(`  APPLIED      ${applied.length}`)
console.log(`  PENDING      ${pending.length}`)

if (pending.length) {
  console.log('\n  Would be applied by `supabase db push`:')
  for (const p of pending) console.log(`    + ${p.file}`)
}

if (orphans.length) {
  // Remote rows with no local file: the CLI refuses to push in this state.
  console.log('\n  APPLIED REMOTELY BUT MISSING LOCALLY (blocks a push):')
  for (const o of orphans) console.log(`    ! ${o.version}  ${o.name ?? ''}`)
}

// ── What the pending migrations would touch that already has data ──────────
const { rows: tables } = await db.query(
  `select table_name from information_schema.tables
    where table_schema = 'public'
      and table_name in ('bank_questions','bank_question_texts','question_topics',
                         'exam_papers','exam_settings','paper_settings','paper_counters',
                         'jobs','difficulty_levels','questions','profiles')
    order by table_name`,
)
console.log('\n  RELEVANT TABLES PRESENT:')
for (const t of tables) console.log(`    · ${t.table_name}`)

const { rows: locales } = await db.query(
  `select preferred_locale, count(*)::int as n from public.profiles group by 1 order by 1`,
)
console.log('\n  profiles.preferred_locale (0053 rewrites hi-Latn → hi):')
for (const l of locales) console.log(`    ${l.preferred_locale.padEnd(10)} ${l.n}`)

const { rows: perms } = await db.query(
  `select count(*)::int as n from public.permissions where key like 'bank.%' or key like 'papers.%'`,
)
console.log(`\n  new permission rows seeded: ${perms[0].n} (expect 10 after db:seed)`)

await db.end()
console.log('')
