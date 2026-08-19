/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Seed the six AIKO topics and import the parsed question bank.
 *
 * Runs AFTER scripts/wipe-and-reset.mjs. Reads the file scripts/parse-aiko.mjs
 * produced — it never parses HTML itself, so what is verified is what lands.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ TOPICS FIRST, BECAUSE bank_import_commit REJECTS UNKNOWN ONES.           │
 * │                                                                           │
 * │ It does not create a topic it has not seen — deliberately, so a typo in a │
 * │ slug produces an error instead of a second topic nobody notices. That     │
 * │ means the six have to exist before the first row is offered.              │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ BATCHED, AND THE BATCHES ARE NOT ATOMIC WITH EACH OTHER.                 │
 * │                                                                           │
 * │ bank_import_commit is atomic per call. 1,023 rows in one call is a large  │
 * │ JSON body and a long transaction over a link measured at ~120ms per round │
 * │ trip; in batches it is quick and a failure names a range instead of       │
 * │ everything. The trade is that a mid-run failure leaves earlier batches    │
 * │ committed — which is why the verification at the end counts what is       │
 * │ actually in the database rather than trusting the tally.                  │
 * │                                                                           │
 * │ That trade is only acceptable because the ORDER is settled before the     │
 * │ first batch goes out — see the box below. A run that would collide is     │
 * │ refused while nothing has been written.                                   │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE ROWS ARE RE-ORDERED AGAINST THE LIVE BANK BEFORE ANYTHING IS SENT.   ║
 * ║                                                                           ║
 * ║ A revision that moves existing English onto a different externalId cannot ║
 * ║ be applied in file order: 0054's dedupe index is partial, therefore not   ║
 * ║ deferrable, therefore checked after every statement, so the moment where  ║
 * ║ both the old owner and the new claimant hold the same sentence is a       ║
 * ║ moment the database sees and refuses. That is what broke the 18 Aug 2026  ║
 * ║ Hard re-import at row 412, after four batches had committed.              ║
 * ║                                                                           ║
 * ║ scripts/lib/import-order.mjs works out a safe order from the bank as it   ║
 * ║ IS, right now. The order is never cached and never written into the file: ║
 * ║ it is a fact about the current database, and a partially-applied import   ║
 * ║ changes it. Recomputing per run is what makes a re-run safe.              ║
 * ║                                                                           ║
 * ║ The keys it compares are computed BY POSTGRES with the index's own        ║
 * ║ expression, on both sides, so "the same text" means the same thing here   ║
 * ║ as it does to the constraint.                                             ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 *   node scripts/import-aiko.mjs                 # dry run
 *   node scripts/import-aiko.mjs --apply
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'
import { applyOrder, planImportOrder } from './lib/import-order.mjs'

const APPLY = process.argv.includes('--apply')
const FILE = process.argv.includes('--file')
  ? process.argv[process.argv.indexOf('--file') + 1]
  : './_aiko.json'
const BATCH = 100

const env = {}
for (const line of readFileSync(resolve('.env.local'), 'utf-8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m) env[m[1]] = m[2].trim()
}
const ref = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split('.')[0]

/*
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THIS IS THE WHOLE INTENDED TAXONOMY, NOT THE TOPICS OF THE CURRENT FILE. │
 * │                                                                           │
 * │ The retirement step below soft-deletes every topic absent from this list. │
 * │ That was written when the list was the six Easy topics and the only other │
 * │ topics were the fourteen samples it was meant to clear out.               │
 * │                                                                           │
 * │ Medium introduces eight more. Had they REPLACED the six rather than been  │
 * │ added to them, the same run that imported Medium would have retired the   │
 * │ Easy taxonomy and orphaned all 1,023 Easy questions — the import would    │
 * │ have reported success while quietly untagging the existing bank.          │
 * │                                                                           │
 * │ So: every topic the product intends to keep belongs here, and the list    │
 * │ grows when a difficulty is added. It is never a per-file list.            │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
const TOPICS = [
  // Easy
  ['Allergens', 'allergens'],
  ['Serving Temperature', 'serving-temperature'],
  ['Portions', 'portions'],
  ['Dietary', 'dietary'],
  ['Dish Type', 'dish-type'],
  ['Menu Sections', 'menu-sections'],
  // Medium
  ['Method Steps', 'method-steps'],
  ['Quality Check Points', 'quality-checks'],
  ['Key Ingredients', 'key-ingredients'],
  ['Cooking Time', 'cooking-time'],
  ['Cooking Temperature', 'cooking-temperature'],
  ['Holding & Storage', 'holding-storage'],
  ['Garnish', 'garnish'],
  ['Serving Notes', 'serving-notes'],
  /*
   * Hard. Five slugs, and two of them deliberately sit BESIDE a Medium slug
   * they resemble rather than reusing it:
   *
   *   'quality-checks'   (Medium) — which QC points does this dish have?
   *   'qc-reasoning'     (Hard)   — a QC point FAILED; what does that imply?
   *
   *   'method-steps'     (Medium) — what is step 4?
   *   'method-reasoning' (Hard)   — WHY is step 4 done that way?
   *
   * Reusing the Medium slug would have been one line shorter and would have
   * merged recall with reasoning under one heading. The counts would still
   * have added up, which is precisely why it would not have been noticed.
   */
  ['Faults & Fixes', 'faults-fixes'],
  ['QC Reasoning', 'qc-reasoning'],
  ['Cross-Comparison', 'cross-comparison'],
  ['Method Reasoning', 'method-reasoning'],
  ['Troubleshooting', 'troubleshooting'],
]

const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST ?? 'aws-0-ap-southeast-1.pooler.supabase.com',
  port: 5432,
  user: `postgres.${ref}`,
  password: env.SUPABASE_DB_PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
})

/** Sign in as an administrator; the RPC checks bank.import on the caller. */
async function tokenFor(email) {
  const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Sample-2026!' }),
  })
  const body = await res.json()
  if (!body.access_token) throw new Error(`sign-in failed for ${email}: ${JSON.stringify(body).slice(0, 200)}`)
  return body.access_token
}

async function commit(token, brandId, rows) {
  const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/bank_import_commit`, {
    method: 'POST',
    headers: {
      apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ p_brand_id: brandId, p_rows: rows }),
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

/** The import FILE shape → the RPC ROW shape. They are deliberately different. */
const toRow = (q) => ({
  externalId: q.externalId,
  difficulty: q.difficulty,
  qtype: q.type,
  status: 'active',
  topicSlug: q.topic,
  correctOption: q.type === 'mcq' ? q.correctOption : null,
  referenceTitle: null,
  referencePage: null,
  texts: [
    {
      locale: 'en',
      question: q.en.question,
      optionA: q.en.options?.A ?? null,
      optionB: q.en.options?.B ?? null,
      optionC: q.en.options?.C ?? null,
      optionD: q.en.options?.D ?? null,
      answerText: q.en.answer ?? null,
      explanation: q.en.explanation ?? null,
    },
  ],
})

try {
  await db.connect()

  const payload = JSON.parse(readFileSync(FILE, 'utf-8'))
  const rows = payload.questions.map(toRow)

  const [brand] = (
    await db.query(`select id, name from public.brands where slug = 'aiko' and deleted_at is null`)
  ).rows
  if (!brand) throw new Error('no brand with slug "aiko"')

  console.log(`\n  ${APPLY ? '*** APPLYING ***' : 'DRY RUN'}\n`)
  console.log(`  file        ${FILE}`)
  console.log(`  brand       ${brand.name}`)
  console.log(`  questions   ${rows.length}`)
  const byType = {}
  for (const r of rows) byType[r.qtype] = (byType[r.qtype] ?? 0) + 1
  for (const [t, n] of Object.entries(byType)) console.log(`    ${t.padEnd(14)}${n}`)

  // ── The order the bank will actually accept ──────────────────────────────
  const englishOf = (row) => row.texts.find((t) => t.locale === 'en')
  const missingEnglish = rows.filter((r) => englishOf(r) === undefined)
  if (missingEnglish.length > 0) {
    throw new Error(
      `${missingEnglish.length} row(s) carry no English text, starting at ` +
        `${missingEnglish[0].externalId}. English is what 0054 dedupes on; a row without it ` +
        `cannot be ordered or imported.`,
    )
  }

  const difficulties = [...new Set(rows.map((r) => r.difficulty))]

  /*
   * NOT filtered by deleted_at, and that is deliberate: 0054's dedupe index is
   * scoped to `locale = 'en'` and to nothing else, so a soft-deleted question
   * still occupies its sentence. Leaving those out would produce an order that
   * looks safe and collides with a row in the recycle bin.
   *
   * Keyed on t.brand_id / t.difficulty rather than the parent's, because those
   * are the columns the index is built on.
   */
  const owners = (
    await db.query(
      `select q.external_id, t.difficulty::text difficulty, lower(btrim(t.question)) key
         from public.bank_question_texts t
         join public.bank_questions q on q.id = t.question_id
        where t.locale = 'en'
          and t.brand_id = $1
          and t.difficulty::text = any($2::text[])
          and q.external_id is not null`,
      [brand.id, difficulties],
    )
  ).rows

  /*
   * The incoming text is normalised by the SAME expression, in the same
   * database, rather than by lower()/trim() here — btrim() strips spaces where
   * JavaScript's trim() also strips tabs and newlines, and one character of
   * disagreement would produce an order this step calls safe and the index
   * then rejects.
   */
  const incoming = (
    await db.query(
      `select i.external_id, lower(btrim(i.question)) key
         from unnest($1::text[], $2::text[]) as i(external_id, question)`,
      [rows.map((r) => r.externalId), rows.map((r) => englishOf(r).question)],
    )
  ).rows

  const scoped = (difficulty, key) => `${difficulty} ${key}`

  const ownership = new Map()
  for (const o of owners) ownership.set(scoped(o.difficulty, o.key), o.external_id)

  const difficultyOf = new Map(rows.map((r) => [r.externalId, r.difficulty]))
  const items = incoming.map((i) => ({
    externalId: i.external_id,
    key: scoped(difficultyOf.get(i.external_id), i.key),
  }))

  const plan = planImportOrder(items, ownership)

  console.log('\n  Order')
  console.log(`    live english texts   ${ownership.size}`)
  console.log(`    dependency edges     ${plan.edges.length}`)
  console.log(`    rows reordered       ${plan.reordered}`)
  console.log(`    cycles               ${plan.cycles.length}`)

  if (plan.reordered > 0) {
    for (const m of plan.moved.slice(0, 5)) {
      console.log(`      ${m.externalId}  row ${m.from + 1} → ${m.to + 1}`)
    }
    if (plan.moved.length > 5) console.log(`      …and ${plan.moved.length - 5} more`)
  }

  /*
   * Refused here, with nothing written. The alternative — discovering it in
   * batch five — is what this whole step exists to prevent, and the previous
   * failure proved the batches do not roll each other back.
   */
  if (!plan.ok) {
    console.log(`\n  ${plan.problems.length} PROBLEM(S):\n`)
    for (const p of plan.problems.slice(0, 20)) console.log(`    ✗ ${p}`)
    if (plan.problems.length > 20) {
      console.log(`    …and ${plan.problems.length - 20} more`)
    }
    console.log('\n  Nothing written.\n')
    await db.end()
    process.exit(1)
  }

  const ordered = applyOrder(rows, plan.order)

  if (!APPLY) {
    console.log('\n  Nothing written. Re-run with --apply\n')
    await db.end()
    process.exit(0)
  }

  // ── Topics ───────────────────────────────────────────────────────────────
  /*
   * ┌─────────────────────────────────────────────────────────────────────────┐
   * │ THE CONFLICT TARGET REPEATS THE INDEX'S WHERE CLAUSE, AND MUST.        │
   * │                                                                         │
   * │ question_topics_slug_uq is a PARTIAL unique index —                     │
   * │ (company_id, slug) WHERE deleted_at IS NULL. A bare                     │
   * │ `on conflict (company_id, slug)` does not match it and Postgres refuses │
   * │ with "no unique or exclusion constraint matching the ON CONFLICT        │
   * │ specification", which is exactly what the first run did.                │
   * └─────────────────────────────────────────────────────────────────────────┘
   */
  console.log('\n  Topics')
  for (const [index, [name, slug]] of TOPICS.entries()) {
    await db.query(
      `insert into public.question_topics (company_id, name, slug, sort_order)
       select c.id, $1, $2, $3 from public.companies c
       on conflict (company_id, slug) where deleted_at is null
       do update set name = excluded.name, sort_order = excluded.sort_order`,
      [name, slug, index + 1],
    )
    console.log(`    + ${slug}`)
  }

  /*
   * Retire the sample taxonomy — Pizza, Pasta, Burger, Salad… for a pan-Asian
   * kitchen. SOFT delete: question_topics carries deleted_at and the partial
   * index above frees the slug the moment it is set, so this is reversible by
   * clearing one column, unlike the bank wipe. Nothing references them now
   * that the sample bank is gone, but a hard delete would still be the wrong
   * default for taxonomy somebody may have meant to keep.
   */
  const retired = await db.query(
    `update public.question_topics set deleted_at = now(), updated_at = now()
      where deleted_at is null and slug <> all($1::text[])`,
    [TOPICS.map(([, slug]) => slug)],
  )
  console.log(`    - retired ${retired.rowCount} sample topic(s)`)

  // ── Import ───────────────────────────────────────────────────────────────
  const token = await tokenFor('sample-chef@example.com')
  console.log('\n  Importing')

  let inserted = 0
  let updated = 0
  for (let i = 0; i < ordered.length; i += BATCH) {
    const slice = ordered.slice(i, i + BATCH)
    const res = await commit(token, brand.id, slice)
    if (res.status !== 200) {
      throw new Error(
        `batch ${i + 1}–${i + slice.length} failed (${res.status}): ${JSON.stringify(res.body).slice(0, 400)}`,
      )
    }
    inserted += res.body?.inserted ?? 0
    updated += res.body?.updated ?? 0
    console.log(`    ${String(i + slice.length).padStart(5)} / ${ordered.length}`)
  }

  console.log(`\n  Reported: ${inserted} inserted, ${updated} updated`)

  // ── What is actually in the database ─────────────────────────────────────
  console.log('\n  Verified against the database\n')
  const counts = (
    await db.query(`
      select q.qtype, q.difficulty, q.status, count(*)::int n
        from public.bank_questions q
       where q.deleted_at is null
       group by 1,2,3 order by 1,2,3`)
  ).rows
  console.table(counts)

  console.table(
    (
      await db.query(`
        select t.slug topic, count(*)::int n
          from public.bank_questions q
          join public.question_topics t on t.id = q.topic_id
         where q.deleted_at is null
         group by 1 order by 2 desc`)
    ).rows,
  )

  const [{ n: untagged }] = (
    await db.query(`select count(*)::int n from public.bank_questions where deleted_at is null and topic_id is null`)
  ).rows
  console.log(`  untagged questions: ${untagged}`)

  const [{ n: noAnswer }] = (
    await db.query(`
      select count(*)::int n from public.bank_questions q
       where q.deleted_at is null and q.qtype = 'mcq' and q.correct_option is null`)
  ).rows
  console.log(`  MCQs with no correct option: ${noAnswer}`)

  console.log('')
} catch (error) {
  console.error(`\n  ${error.message}\n`)
  process.exitCode = 1
} finally {
  await db.end()
}
