/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Recover the recipe/item vocabulary from the question bank. READ-ONLY.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ WHY THIS EXISTS, AND WHY ITS OUTPUT IS REVIEWED BEFORE IT IS APPLIED.     ║
 * ║                                                                           ║
 * ║ The bank has no item column and never had one: a question names its dish  ║
 * ║ only inside its own text, in each language separately. The English source ║
 * ║ that generated these questions is not in the repository, so the item      ║
 * ║ association has to be recovered from the text or invented by hand.        ║
 * ║                                                                           ║
 * ║ Recovering it is safe ONLY because the phrasing is templated: the same    ║
 * ║ dozen sentence shapes repeat thousands of times, and the dish sits in a   ║
 * ║ fixed slot in each. This reads those slots. It does NOT guess at nouns,   ║
 * ║ does not use frequency heuristics, and does not touch a question whose    ║
 * ║ shape it does not recognise.                                              ║
 * ║                                                                           ║
 * ║ It WRITES NOTHING TO THE DATABASE. It emits a file for a person to read   ║
 * ║ before a separate script applies it, because an item list nobody checked  ║
 * ║ would become the thing paper exclusions are silently enforced against.    ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 *   node scripts/extract-items.mjs            # writes items.extracted.json
 *   node scripts/extract-items.mjs --verbose  # also lists every untagged question
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'

const VERBOSE = process.argv.includes('--verbose')
const OUT = resolve('items.extracted.json')

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

/*
 * A capitalised phrase: the shape a dish name takes in these questions.
 * Unicode-aware on purpose — "Jalapeño Popper Roll" and "Crème Brûlée" are
 * real dishes, and an ASCII \w would silently truncate both.
 */
const NAME = "\\p{Lu}[\\p{L}\\p{N}'’-]*(?:[ &][\\p{Lu}\\p{N}][\\p{L}\\p{N}'’-]*)*"

/**
 * The sentence shapes whose dish slot is unambiguous.
 *
 * Every one anchors on fixed words either side of the name, so what is
 * captured cannot drift into the rest of the sentence. Shapes not listed here
 * are not guessed at — they simply contribute no vocabulary.
 */
const TEMPLATES = [
  { re: `\\bfor the (${NAME})\\s*\\??$`, why: 'trailing "for the X"' },
  { re: `\\bin the (${NAME}) recipe\\b`, why: '"in the X recipe"' },
  { re: `\\bis the (${NAME}) (?:served|prepared|classified|listed)\\b`, why: '"is the X served"' },
  { re: `^A chef'?s (${NAME}) has\\b`, why: '"A chef\'s X has"' },
  { re: `^A chef preparing (${NAME})\\b`, why: '"A chef preparing X"' },
  { re: `\\byou find (${NAME})\\s*\\??$`, why: '"where will you find X"' },
  { re: `\\bboth (${NAME}) and (${NAME})\\s*\\??$`, why: '"both X and Y"' },
  { re: `\\btemperature is (${NAME}) served\\b`, why: '"temperature is X served"' },
  { re: `\\bDoes (${NAME}) list\\b`, why: '"Does X list"' },
  { re: `\\bHow is (${NAME}) classified\\b`, why: '"How is X classified"' },
  { re: `\\bpreparing the (${NAME})\\s*\\??$`, why: '"preparing the X"' },
  { re: `\\bof the (${NAME})\\s*\\??$`, why: 'trailing "of the X"' },
  { re: `\\bis (${NAME}) prepared at\\b`, why: '"is X prepared at"' },
].map((t) => ({ ...t, rx: new RegExp(t.re, 'u') }))

/**
 * One dish, one canonical name.
 *
 * "Hulk", "Hulk pizza", "11-inch Hulk pizza" and "15-inch Hulk pizza" are the
 * same pizza asked about four ways, and an exclusion has to catch all four.
 * The size prefix is stripped because it describes a portion, not a dish; a
 * trailing lowercase "pizza" is stripped because it is a category the sentence
 * added, while a capitalised "Pizza" is part of the name itself ("Hell Boy
 * Pizza") and is kept.
 */
function canonicalise(surface) {
  return surface
    .replace(/^\d+\s*-?\s*inch\s+/iu, '')
    .replace(/\s+pizza$/u, '')
    .trim()
}

await db.connect()

const { rows } = await db.query(`
  select q.id, q.external_id, q.difficulty, q.qtype,
         b.name as brand, b.id as brand_id,
         t.question
    from public.bank_questions q
    join public.brands b on b.id = q.brand_id
    join public.bank_question_texts t
      on t.question_id = q.id and t.locale = 'en'
   where q.deleted_at is null
     and q.status = 'active'
     and b.deleted_at is null
   order by b.name, q.difficulty, q.external_id nulls last
`)

await db.end()

console.log(`\n  Read ${rows.length} active questions with English text.\n`)

// ── Pass 1: vocabulary, from anchored slots only ────────────────────────────
/** brand -> canonical -> Set(surface forms) */
const vocab = new Map()

for (const row of rows) {
  const q = row.question.trim()
  for (const t of TEMPLATES) {
    const m = q.match(t.rx)
    if (!m) continue
    for (const captured of m.slice(1)) {
      if (!captured) continue
      const surface = captured.trim()
      const canonical = canonicalise(surface)
      if (canonical.length < 3) continue
      if (!vocab.has(row.brand)) vocab.set(row.brand, new Map())
      const byName = vocab.get(row.brand)
      if (!byName.has(canonical)) byName.set(canonical, new Set())
      byName.get(canonical).add(surface)
      byName.get(canonical).add(canonical)
    }
    break
  }
}

// ── Pass 2: tag every question against the closed vocabulary ────────────────
/*
 * Longest alias first, and each match masked out before the next is tried, so
 * "Fried Rice" cannot also match inside "Mushroom Truffle Fried Rice" and
 * report two dishes where the sentence named one.
 */
const perBrand = new Map()

for (const [brand, byName] of vocab) {
  const aliases = []
  for (const [canonical, surfaces] of byName) {
    for (const s of surfaces) aliases.push({ canonical, alias: s })
  }
  aliases.sort((a, b) => b.alias.length - a.alias.length)
  perBrand.set(brand, aliases)
}

const mapping = []
const untagged = []
const itemCounts = new Map()

for (const row of rows) {
  const aliases = perBrand.get(row.brand) ?? []
  let haystack = row.question
  const hits = new Set()

  for (const { canonical, alias } of aliases) {
    if (!haystack.includes(alias)) continue
    hits.add(canonical)
    haystack = haystack.split(alias).join('·')
  }

  if (hits.size === 0) {
    untagged.push({ brand: row.brand, externalId: row.external_id, question: row.question })
    continue
  }

  mapping.push({
    questionId: row.id,
    externalId: row.external_id,
    brand: row.brand,
    items: [...hits].sort(),
  })

  for (const h of hits) {
    const key = `${row.brand}::${h}`
    itemCounts.set(key, (itemCounts.get(key) ?? 0) + 1)
  }
}

// ── Report ──────────────────────────────────────────────────────────────────
const brands = [...vocab.keys()].sort()
const items = []

for (const brand of brands) {
  const rowsOfBrand = rows.filter((r) => r.brand === brand)
  const untaggedOfBrand = untagged.filter((u) => u.brand === brand)
  const names = [...(vocab.get(brand) ?? new Map()).keys()].sort()

  console.log(`  ${brand}`)
  console.log(`    questions           ${rowsOfBrand.length}`)
  console.log(`    distinct items      ${names.length}`)
  console.log(
    `    untagged            ${untaggedOfBrand.length}` +
      ` (${((untaggedOfBrand.length / rowsOfBrand.length) * 100).toFixed(1)}%)`,
  )

  const listed = names
    .map((n) => ({ name: n, count: itemCounts.get(`${brand}::${n}`) ?? 0 }))
    .sort((a, b) => b.count - a.count)

  for (const entry of listed) {
    items.push({
      brand,
      name: entry.name,
      aliases: [...vocab.get(brand).get(entry.name)].sort(),
      questionCount: entry.count,
    })
  }

  console.log(
    `    top items           ${listed
      .slice(0, 6)
      .map((i) => `${i.name} (${i.count})`)
      .join(', ')}`,
  )
  console.log('')
}

if (VERBOSE) {
  console.log('  UNTAGGED QUESTIONS')
  for (const u of untagged) console.log(`    [${u.brand}] ${u.question}`)
  console.log('')
}

/*
 * Zero-count items are a extraction fault, not a finding: a name reached the
 * vocabulary from an anchored slot, so at least the question it came from must
 * match it back. Reported rather than dropped.
 */
const orphans = items.filter((i) => i.questionCount === 0)
if (orphans.length > 0) {
  console.log(`  ⚠ ${orphans.length} extracted name(s) matched no question:`)
  for (const o of orphans) console.log(`      ${o.brand} — "${o.name}"`)
  console.log('')
}

writeFileSync(
  OUT,
  JSON.stringify(
    {
      generatedFrom: `${rows.length} active questions`,
      note:
        'REVIEW BEFORE APPLYING. `items` is the vocabulary that will be created; ' +
        '`mapping` ties each question to one or more of them; `untagged` lists ' +
        'questions no template recognised — those keep no item and appear in the ' +
        'generator as the "No item" bucket.',
      items,
      mapping,
      untagged,
    },
    null,
    2,
  ) + '\n',
)

console.log(`  Wrote ${OUT}`)
console.log(`    items    ${items.length}`)
console.log(`    mapped   ${mapping.length} questions`)
console.log(`    untagged ${untagged.length} questions\n`)
