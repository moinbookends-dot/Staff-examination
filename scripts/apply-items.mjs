/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Apply the reviewed item extraction to the bank.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ READS items.extracted.json. WRITES ONLY THE TWO NEW TABLES.               ║
 * ║                                                                           ║
 * ║ It creates bank_items rows and bank_question_items links. It does not     ║
 * ║ UPDATE a single question: no text, no topic, no status, no external id.   ║
 * ║ The association is new information about existing rows, and adding it     ║
 * ║ must not be able to damage the thing it describes.                        ║
 * ║                                                                           ║
 * ║ IDEMPOTENT. Items match on (brand, slug) and links on their primary key,  ║
 * ║ so a second run re-links what is already linked and adds whatever the     ║
 * ║ file gained. Re-running after a corrected extraction is the intended way  ║
 * ║ to fix a mistake — but note it only ADDS: a link removed from the file is ║
 * ║ reported and left in place rather than silently deleted.                  ║
 * ║                                                                           ║
 * ║ ONE TRANSACTION. A half-applied vocabulary would mean exclusions that     ║
 * ║ catch some of a dish's questions and miss the rest, which is worse than   ║
 * ║ no exclusions at all.                                                     ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 *   node scripts/apply-items.mjs           # dry run — reports what would change
 *   node scripts/apply-items.mjs --apply   # writes, in one transaction
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'

const APPLY = process.argv.includes('--apply')
const FILE = resolve('items.extracted.json')

function readEnvLocal() {
  const raw = readFileSync(resolve('.env.local'), 'utf-8')
  const out = {}
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) out[m[1]] = m[2].trim()
  }
  return out
}

/** The same slug rule the import contract and question_topics use. */
const slugify = (value) =>
  value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

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

const file = JSON.parse(readFileSync(FILE, 'utf-8'))

console.log(`\n  ${APPLY ? 'APPLYING' : 'DRY RUN'} — ${FILE}`)
console.log(`    items    ${file.items.length}`)
console.log(`    mapping  ${file.mapping.length} questions`)
console.log(`    untagged ${file.untagged.length} questions\n`)

// Slug collisions would silently merge two dishes into one exclusion.
const bySlug = new Map()
for (const item of file.items) {
  const key = `${item.brand}/${slugify(item.name)}`
  if (bySlug.has(key)) {
    console.error(`  ✖ slug collision: "${item.name}" and "${bySlug.get(key)}" both → ${key}`)
    process.exit(1)
  }
  bySlug.set(key, item.name)
}

await db.connect()

const { rows: brandRows } = await db.query(
  `select id, name, company_id from public.brands where deleted_at is null`,
)
const brandByName = new Map(brandRows.map((b) => [b.name, b]))

for (const item of file.items) {
  if (!brandByName.has(item.brand)) {
    console.error(`  ✖ unknown brand "${item.brand}" — is it retired?`)
    await db.end()
    process.exit(1)
  }
}

/*
 * Every question id in the file must still exist, be active, and belong to the
 * brand the file claims. An extraction run against a bank that has since
 * changed would otherwise link a question to another brand's dish.
 */
const ids = file.mapping.map((m) => m.questionId)
const { rows: liveRows } = await db.query(
  `select q.id, b.name as brand
     from public.bank_questions q
     join public.brands b on b.id = q.brand_id
    where q.id = any($1::uuid[]) and q.deleted_at is null and q.status = 'active'`,
  [ids],
)
const liveBrand = new Map(liveRows.map((r) => [r.id, r.brand]))

const missing = file.mapping.filter((m) => !liveBrand.has(m.questionId))
const moved = file.mapping.filter(
  (m) => liveBrand.has(m.questionId) && liveBrand.get(m.questionId) !== m.brand,
)

if (missing.length > 0) console.log(`  ⚠ ${missing.length} question(s) in the file no longer active — skipped`)
if (moved.length > 0) {
  console.error(`  ✖ ${moved.length} question(s) changed brand since extraction. Re-run extract-items.mjs.`)
  await db.end()
  process.exit(1)
}

const linkCount = file.mapping
  .filter((m) => liveBrand.has(m.questionId))
  .reduce((n, m) => n + m.items.length, 0)

console.log(`  Would create up to ${file.items.length} item(s) and ${linkCount} link(s).\n`)

if (!APPLY) {
  console.log('  Nothing written. Re-run with --apply once the file has been reviewed.\n')
  await db.end()
  process.exit(0)
}

try {
  await db.query('begin')

  // ── Items ────────────────────────────────────────────────────────────────
  const itemId = new Map()
  let createdItems = 0

  for (const item of file.items) {
    const brand = brandByName.get(item.brand)
    const slug = slugify(item.name)

    const { rows } = await db.query(
      `insert into public.bank_items (company_id, brand_id, name, slug)
       values ($1, $2, $3, $4)
       on conflict (company_id, brand_id, slug) where deleted_at is null
       do update set name = excluded.name, updated_at = now()
       returning id, (xmax = 0) as inserted`,
      [brand.company_id, brand.id, item.name, slug],
    )

    itemId.set(`${item.brand}/${item.name}`, rows[0].id)
    if (rows[0].inserted) createdItems += 1
  }

  // ── Links ────────────────────────────────────────────────────────────────
  let createdLinks = 0

  for (const row of file.mapping) {
    if (!liveBrand.has(row.questionId)) continue

    for (const name of row.items) {
      const id = itemId.get(`${row.brand}/${name}`)
      if (!id) {
        throw new Error(`mapping names "${name}" for ${row.brand}, which is not in items[]`)
      }

      const res = await db.query(
        `insert into public.bank_question_items (question_id, item_id)
         values ($1, $2) on conflict do nothing`,
        [row.questionId, id],
      )
      createdLinks += res.rowCount
    }
  }

  await db.query('commit')

  console.log(`  Created ${createdItems} item(s) and ${createdLinks} link(s).`)
} catch (err) {
  await db.query('rollback')
  console.error(`\n  ✖ Rolled back — nothing was written.\n    ${err.message}\n`)
  await db.end()
  process.exit(1)
}

// ── Verify against the database rather than against our own counters ────────
const check = await db.query(`
  select b.name as brand,
         count(distinct i.id)::int as items,
         count(distinct qi.question_id)::int as tagged,
         count(*) filter (where qi.question_id is not null)::int as links
    from public.brands b
    left join public.bank_items i on i.brand_id = b.id and i.deleted_at is null
    left join public.bank_question_items qi on qi.item_id = i.id
   where b.deleted_at is null
   group by b.name order by b.name
`)

console.log('')
for (const r of check.rows) {
  console.log(`  ${r.brand}: ${r.items} items · ${r.tagged} questions tagged · ${r.links} links`)
}
console.log('')

await db.end()
