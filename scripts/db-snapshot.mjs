/**
 * READ-ONLY. Dump every schema object name to a JSON file for before/after diff.
 *
 * "No unexpected objects were dropped" is only verifiable against a recorded
 * baseline. A spot check of five tables proves nothing about the other thirty.
 *
 *   node scripts/db-snapshot.mjs before
 *   …run the migration…
 *   node scripts/db-snapshot.mjs after
 *   node scripts/db-snapshot.mjs diff
 *
 * Writes to scripts/.spike/ which is gitignored. Contains no credentials —
 * object names and row counts only.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'

const OUT = resolve('scripts/.spike')
const mode = process.argv[2] ?? 'before'

if (mode === 'diff') {
  const before = JSON.parse(readFileSync(resolve(OUT, 'db-before.json'), 'utf8'))
  const after = JSON.parse(readFileSync(resolve(OUT, 'db-after.json'), 'utf8'))

  const report = (label, a, b) => {
    const removed = a.filter((x) => !b.includes(x))
    const added = b.filter((x) => !a.includes(x))
    console.log(`\n  ${label}: ${a.length} → ${b.length}`)
    if (removed.length) console.log(`    REMOVED (${removed.length}): ${removed.join(', ')}`)
    else console.log('    removed: none')
    if (added.length) console.log(`    added   (${added.length}): ${added.join(', ')}`)
  }

  report('TABLES', before.tables, after.tables)
  report('FUNCTIONS', before.functions, after.functions)
  report('POLICIES', before.policies, after.policies)
  report('ENUM TYPES', before.enums, after.enums)

  console.log('\n  ROW COUNTS (existing data must be intact):')
  for (const key of Object.keys(before.counts)) {
    const a = before.counts[key]
    const b = after.counts[key]
    const flag = a === b ? '   ok' : a > b ? '  LOST' : '  grew'
    console.log(`   ${flag}  ${key.padEnd(22)} ${a} → ${b}`)
  }
  process.exit(0)
}

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

const list = async (sql) => (await db.query(sql)).rows.map((r) => Object.values(r)[0]).sort()

const snapshot = {
  tables: await list(
    `select table_name from information_schema.tables where table_schema='public' and table_type='BASE TABLE'`,
  ),
  functions: await list(
    `select routine_name from information_schema.routines where routine_schema='public'`,
  ),
  policies: await list(`select schemaname||'.'||tablename||'.'||policyname from pg_policies where schemaname='public'`),
  enums: await list(
    `select t.typname from pg_type t join pg_namespace n on n.oid=t.typnamespace
      where n.nspname='public' and t.typtype='e'`,
  ),
  counts: {},
}

/* Row counts on the tables that hold real data. If any of these shrinks, the
   migration destroyed something it had no business touching. */
for (const table of [
  'profiles',
  'companies',
  'brands',
  'outlets',
  'departments',
  'roles',
  'permissions',
  'role_permissions',
  'user_roles',
  'questions',
  'exams',
  'attempts',
  'source_documents',
  'audit_logs',
]) {
  try {
    const { rows } = await db.query(`select count(*)::int as n from public.${table}`)
    snapshot.counts[table] = rows[0].n
  } catch {
    snapshot.counts[table] = -1 // table absent
  }
}

mkdirSync(OUT, { recursive: true })
const file = resolve(OUT, `db-${mode}.json`)
writeFileSync(file, JSON.stringify(snapshot, null, 2))

console.log(`\n  ${mode}: ${snapshot.tables.length} tables, ${snapshot.functions.length} functions, ${snapshot.policies.length} policies, ${snapshot.enums.length} enums`)
console.log(`  written to ${file}`)
if (!existsSync(resolve(OUT, 'db-before.json'))) console.log('  (no baseline yet)')

await db.end()
