/**
 * READ-ONLY verification that 0058 landed as written.
 *
 * Every statement is a SELECT against the catalogs. The interesting assertion
 * is the last one: bank_import_commit must be SECURITY INVOKER. If a later
 * edit ever made it definer, imports would silently start bypassing RLS and
 * nothing in the application would notice.
 *
 *   node scripts/db-verify-0058.mjs
 */

import { readFileSync } from 'node:fs'
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

let failures = 0
const check = (ok, label, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : ` — ${detail}`}`)
  if (!ok) failures += 1
}

await db.connect()
console.log('')

// ── The column ───────────────────────────────────────────────────────────────
const col = await db.query(`
  select data_type, is_nullable
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'bank_questions'
     and column_name  = 'external_id'
`)
check(col.rowCount === 1, 'bank_questions.external_id exists')
check(col.rows[0]?.is_nullable === 'YES', 'external_id is nullable (hand-written questions have none)')

// ── The index ────────────────────────────────────────────────────────────────
const idx = await db.query(`
  select indexdef from pg_indexes
   where schemaname = 'public' and indexname = 'bank_questions_external_id_uq'
`)
check(idx.rowCount === 1, 'bank_questions_external_id_uq exists')
check(
  /UNIQUE/i.test(idx.rows[0]?.indexdef ?? '') &&
    /company_id.*brand_id.*external_id/s.test(idx.rows[0]?.indexdef ?? ''),
  'the index is UNIQUE and scoped (company_id, brand_id, external_id)',
  idx.rows[0]?.indexdef,
)
check(
  /WHERE \(external_id IS NOT NULL\)/i.test(idx.rows[0]?.indexdef ?? ''),
  'the index is partial, so many questions may have no external id',
  idx.rows[0]?.indexdef,
)

// ── No existing row was touched ──────────────────────────────────────────────
const rows = await db.query(`
  select count(*)::int as total,
         count(external_id)::int as with_external
    from public.bank_questions
`)
check(
  rows.rows[0].with_external === 0,
  `no existing question was given an external id (${rows.rows[0].total} rows, ${rows.rows[0].with_external} with an id)`,
)

// ── The function ─────────────────────────────────────────────────────────────
const fn = await db.query(`
  select p.prosecdef, p.provolatile, pg_get_function_identity_arguments(p.oid) as args
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'bank_import_commit'
`)
check(fn.rowCount === 1, 'bank_import_commit() exists')
check(fn.rows[0]?.args === 'p_brand_id uuid, p_rows jsonb', 'its signature is (uuid, jsonb)', fn.rows[0]?.args)

// The assertion this script exists for.
check(
  fn.rows[0]?.prosecdef === false,
  'bank_import_commit is SECURITY INVOKER — RLS still authorises every write',
  fn.rows[0]?.prosecdef ? 'IT IS SECURITY DEFINER, WHICH BYPASSES RLS' : '',
)

const grants = await db.query(`
  select has_function_privilege('authenticated', p.oid, 'execute') as auth_can,
         has_function_privilege('anon',          p.oid, 'execute') as anon_can
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'bank_import_commit'
`)
check(grants.rows[0]?.auth_can === true, 'authenticated may execute it')
check(grants.rows[0]?.anon_can === false, 'anon may NOT execute it')

// ── Nothing else moved ───────────────────────────────────────────────────────
/*
 * 0055 creates four policies per table and 0058 adds none, so eight is the
 * whole set:
 *   bank_questions       read, read_deleted, insert, update  (NO delete, by design)
 *   bank_question_texts  read, insert, update, delete
 */
const policies = await db.query(`
  select tablename, policyname, cmd from pg_policies
   where schemaname = 'public' and tablename in ('bank_questions', 'bank_question_texts')
   order by tablename, policyname
`)
check(policies.rowCount === 8, `bank RLS policies unchanged (${policies.rowCount})`, 'expected 8')

// On `cmd`, not the policy NAME — bank_questions_read_deleted is a SELECT
// policy for the recycle bin and its name contains "delete".
check(
  !policies.rows.some((r) => r.tablename === 'bank_questions' && r.cmd === 'DELETE'),
  'bank_questions still has no DELETE policy — the reason the import must be atomic',
)

const audit = await db.query(`select count(*)::int as n from public.audit_logs`)
console.log(`\n  audit_logs rows: ${audit.rows[0].n}`)

await db.end()

console.log(failures === 0 ? '\n  0058 verified.\n' : `\n  ${failures} check(s) FAILED.\n`)
process.exit(failures === 0 ? 0 : 1)
