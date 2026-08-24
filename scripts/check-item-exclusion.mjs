/**
 * End-to-end: exclude Hulk, draw a Capiche paper, prove not one Hulk question
 * appears. Runs against the LIVE RPCs with a real signed-in session, so the
 * permission gates and the SQL predicates are both exercised.
 *
 * Does not sign out — that revokes every session for the account, including
 * the browser's.
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

const supabase = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY)
const { error: loginErr } = await supabase.auth.signInWithPassword({
  email: 'sample-superadmin@example.com',
  password: 'Sample-2026!',
})
if (loginErr) {
  console.error('login failed:', loginErr.message)
  process.exit(1)
}

// ── The item ────────────────────────────────────────────────────────────────
const { data: items } = await supabase
  .from('bank_items')
  .select('id, name, in_use')
  .eq('brand_id', CAPICHE)
  .eq('name', 'Hulk')

const hulk = items?.[0]
if (!hulk) {
  console.error('no Hulk item found')
  process.exit(1)
}
console.log(`\n  Item: ${hulk.name}  (${hulk.id})`)

// ── Eligible counts, before and after ───────────────────────────────────────
const counts = async (excluded) => {
  const { data, error } = await supabase.rpc('bank_eligible_counts', {
    p_brand_id: CAPICHE,
    p_difficulty: 'easy',
    p_topic_ids: null,
    p_include_no_topic: true,
    p_exclude_item_ids: excluded,
    p_include_no_item: true,
  })
  if (error) throw new Error(error.message)
  const mcq = data.find((r) => r.qtype === 'mcq')?.n ?? 0
  const sa = data.find((r) => r.qtype === 'short_answer')?.n ?? 0
  return { mcq, sa, total: mcq + sa }
}

const before = await counts([])
const after = await counts([hulk.id])

console.log(`\n  Eligible, nothing excluded : ${before.mcq} MCQ + ${before.sa} short = ${before.total}`)
console.log(`  Eligible, Hulk excluded    : ${after.mcq} MCQ + ${after.sa} short = ${after.total}`)
console.log(`  Difference                 : ${before.total - after.total}`)

// ── The draw itself ─────────────────────────────────────────────────────────
const draw = async (qtype, n, excluded) => {
  const { data, error } = await supabase.rpc('bank_draw_question_ids', {
    p_brand_id: CAPICHE,
    p_difficulty: 'easy',
    p_qtype: qtype,
    p_count: n,
    p_topic_ids: null,
    p_include_no_topic: true,
    p_exclude_item_ids: excluded,
    p_include_no_item: true,
  })
  if (error) throw new Error(error.message)
  return data.map((r) => r.id)
}

// The set of question ids that are actually about Hulk, read independently of
// the draw so this is a real check rather than a restatement of the filter.
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
const { rows: hulkRows } = await db.query(
  `select question_id from public.bank_question_items where item_id = $1`,
  [hulk.id],
)
const hulkIds = new Set(hulkRows.map((r) => r.question_id))
console.log(`\n  Questions about Hulk in the bank: ${hulkIds.size}`)

let leaked = 0
let drawn = 0
for (let round = 0; round < 40; round += 1) {
  const mcq = await draw('mcq', 16, [hulk.id])
  const sa = await draw('short_answer', 4, [hulk.id])
  drawn += mcq.length + sa.length
  for (const id of [...mcq, ...sa]) if (hulkIds.has(id)) leaked += 1
}

console.log(`\n  40 draws · ${drawn} questions drawn`)
console.log(`  Hulk questions that leaked through: ${leaked}`)

// Control: without the exclusion, Hulk questions DO turn up — otherwise the
// result above would prove nothing but a small pool.
let control = 0
for (let round = 0; round < 40; round += 1) {
  const mcq = await draw('mcq', 16, [])
  for (const id of mcq) if (hulkIds.has(id)) control += 1
}
console.log(`  Control (no exclusion), Hulk drawn : ${control}`)

console.log(
  `\n  ${leaked === 0 && control > 0 ? 'PASS' : 'FAIL'} — excluded: ${leaked}, control: ${control}\n`,
)

await db.end()
process.exit(leaked === 0 && control > 0 ? 0 : 1)
