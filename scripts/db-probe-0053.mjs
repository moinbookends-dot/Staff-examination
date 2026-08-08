/** READ-ONLY. Did 0053 partially apply, or did it roll back cleanly? */
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

const probes = [
  ['enum bank_difficulty', `select exists(select 1 from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' and t.typname='bank_difficulty') as x`],
  ['enum bank_question_type', `select exists(select 1 from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' and t.typname='bank_question_type') as x`],
  ['enum bank_question_status', `select exists(select 1 from pg_type t join pg_namespace n on n.oid=t.typnamespace where n.nspname='public' and t.typname='bank_question_status') as x`],
  ['table question_topics', `select to_regclass('public.question_topics') is not null as x`],
  ['table exam_settings', `select to_regclass('public.exam_settings') is not null as x`],
  ['fn required_locales_for', `select exists(select 1 from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname='required_locales_for') as x`],
]

console.log('\n  0053 OBJECTS:')
for (const [label, sql] of probes) {
  const { rows } = await db.query(sql)
  console.log(`    ${rows[0].x ? 'EXISTS  ' : 'absent  '}${label}`)
}

const { rows: hist } = await db.query(
  `select version from supabase_migrations.schema_migrations where version >= '20260805' order by version`,
)
console.log(`\n  HISTORY ROWS FOR 0053+: ${hist.length ? hist.map((h) => h.version).join(', ') : 'none'}`)

// The CHECK constraint 0053 tightens, and the locale data it rewrites.
const { rows: chk } = await db.query(
  `select pg_get_constraintdef(oid) as def from pg_constraint
    where conname = 'profiles_preferred_locale_check'`,
)
console.log(`\n  profiles_preferred_locale_check: ${chk[0]?.def ?? 'ABSENT'}`)

const { rows: loc } = await db.query(
  `select preferred_locale, count(*)::int n from public.profiles group by 1 order by 1`,
)
console.log('  profiles by locale:')
for (const l of loc) console.log(`    ${l.preferred_locale.padEnd(10)} ${l.n}`)

// Does the live function still admit the Hinglish tag in its ALLOWLIST
// (as opposed to merely mentioning it in a comment)?
const { rows: fn } = await db.query(
  `select pg_get_functiondef(p.oid) as src from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname='public' and p.proname='handle_new_user'`,
)
const src = fn[0]?.src ?? ''
const code = src.replace(/--[^\n]*/g, '')
console.log(`\n  handle_new_user present: ${Boolean(src)}`)
console.log(`    keeps employee-role grant: ${code.includes('user_roles') && code.includes('employee')}`)
console.log(`    keeps pending status:      ${code.includes('pending')}`)
console.log(`    CODE still allows Hinglish: ${code.includes('hi-Latn')}`)
console.log(`    COMMENTS mention Hinglish:  ${src.includes('hi-Latn') && !code.includes('hi-Latn')}`)

await db.end()
console.log('')
