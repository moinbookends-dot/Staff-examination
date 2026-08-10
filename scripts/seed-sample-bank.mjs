/**
 * ═════════════════════════════════════════════════════════════════════════════
 * Sample question bank + an Editor login, so the product can be tried by hand.
 *
 *   npm run db:sample            seed
 *   npm run db:sample -- --clean remove everything it created
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ DEMONSTRATION DATA. NOT THE QUESTION BANK.                                ║
 * ║                                                                           ║
 * ║ Every question carries external_id `sample-<level>-<n>`, and --clean       ║
 * ║ deletes exactly those. The curated 3,000 will arrive through the frozen    ║
 * ║ import contract and is untouched by this file in either direction.         ║
 * ║                                                                           ║
 * ║ Difficulty here is an arbitrary bucket so the generator's three cards have ║
 * ║ data behind them. It is NOT a judgement about any question, and nothing    ║
 * ║ in the application infers a level from content.                            ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Structured like scripts/seed-demo.mjs: one owner connection, fixed derivable
 * ids, idempotent, undoable. Deliberately NOT routed through
 * bank_import_commit() — that needs an Editor JWT and a session, which a seed
 * script has neither of. The import path is proven separately by check:import.
 * ═════════════════════════════════════════════════════════════════════════════
 */
import { Client } from 'pg'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildCorpus } from './sample-questions.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function readEnvLocal() {
  const raw = readFileSync(resolve(root, '.env.local'), 'utf-8')
  const out = {}
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) out[m[1]] = m[2].trim()
  }
  return out
}

const env = readEnvLocal()
const ref = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split('.')[0]
const CLEAN = process.argv.includes('--clean')

/*
 * The sample logins, read from the SAME file the login screen's quick-fill
 * panel reads. One source, so a password shown on screen cannot drift from the
 * password the account actually has.
 */
const DEV_ACCOUNTS = JSON.parse(
  readFileSync(resolve(root, 'dev-accounts.json'), 'utf-8'),
)
const SAMPLE_PASSWORD = DEV_ACCOUNTS.password

const BRAND_NAME = 'Aiko'
const LEVELS = ['easy', 'medium', 'hard']

const db = new Client({
  host: process.env.SUPABASE_DB_HOST ?? 'aws-0-ap-southeast-1.pooler.supabase.com',
  port: 5432,
  user: `postgres.${ref}`,
  password: env.SUPABASE_DB_PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
})

const admin = (path, init = {}) =>
  fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })

await db.connect()

// ─────────────────────────────────────────────────────────────────────────────
if (CLEAN) {
  /*
   * Papers before questions. exam_paper_questions.question_id is ON DELETE
   * RESTRICT so a question that has appeared on an issued paper cannot be
   * erased out from under its own exam history — the sample papers have to go
   * first, and only the ones drawn from sample questions.
   */
  const papers = await db.query(`
    delete from public.exam_papers p
     where exists (
       select 1 from public.exam_paper_questions q
        join public.bank_questions b on b.id = q.question_id
       where q.paper_id = p.id and b.external_id like 'sample-%'
     )`)

  const questions = await db.query(
    `delete from public.bank_questions where external_id like 'sample-%'`,
  )

  const emails = DEV_ACCOUNTS.accounts.map((a) => a.email)
  const editor = await db.query(`select id from public.profiles where email = any($1)`, [emails])
  for (const row of editor.rows) {
    await admin(`/auth/v1/admin/users/${row.id}`, { method: 'DELETE' })
  }

  console.log(`\n  removed ${papers.rowCount} sample papers, ${questions.rowCount} questions, ${editor.rowCount} editor account(s)`)
  const left = await db.query(`select count(*)::int n from public.bank_questions`)
  console.log(`  bank_questions now: ${left.rows[0].n}\n`)
  await db.end()
  process.exit(0)
}

// ─────────────────────────────────────────────────────────────────────────────
const company = (await db.query(`select id, name from public.companies limit 1`)).rows[0]
const brand = (
  await db.query(`select id, name from public.brands where name = $1 and deleted_at is null`, [BRAND_NAME])
).rows[0]

if (!brand) throw new Error(`Brand ${BRAND_NAME} not found — run npm run db:seed first.`)

const topics = new Map(
  (await db.query(`select slug, id from public.question_topics where company_id = $1 and deleted_at is null`, [company.id]))
    .rows.map((r) => [r.slug, r.id]),
)

console.log(`\n  seeding into ${company.name} / ${brand.name}`)

// ── The Editor account ───────────────────────────────────────────────────────
//
// Created BEFORE the questions so bank_questions.created_by can point at a real
// person: the insert policy requires created_by = auth.uid() for an application
// caller, and attributing seeded content to an account that can actually edit it
// is more honest than pinning it on whoever happens to be first in the table.
/*
 * Every account is approved, outlet-pinned, and granted exactly one role.
 *
 * The outlet matters: custom_access_token_hook derives brand_id from it at
 * SIGN-IN, and an account without one has a null brand — which makes the
 * generator's pool filter match nothing and the screen report an empty bank.
 * That is exactly how a test account fooled me during verification.
 */
const outlet = (
  await db.query(`select id from public.outlets where brand_id = $1 and deleted_at is null limit 1`, [brand.id])
).rows[0]

async function ensureAccount({ role, email, label }) {
  let id = (await db.query(`select id from public.profiles where email = $1`, [email])).rows[0]?.id

  if (!id) {
    const res = await admin('/auth/v1/admin/users', {
      method: 'POST',
      body: JSON.stringify({
        email,
        password: SAMPLE_PASSWORD,
        email_confirm: true,
        user_metadata: { full_name: `Sample ${label}`, locale: 'en' },
      }),
    })
    if (!res.ok) throw new Error(`create ${role}: ${res.status} ${await res.text()}`)
    id = (await res.json()).id
    console.log(`  created ${email.padEnd(32)} ${role}`)
  } else {
    console.log(`  reusing ${email.padEnd(32)} ${role}`)
  }

  await db.query(
    `update public.profiles set approval_status = 'approved', outlet_id = $2 where id = $1`,
    [id, outlet?.id ?? null],
  )
  await db.query(
    `insert into public.user_roles (user_id, role_id)
     select $1, id from public.roles where key = $2 and company_id is null
     on conflict do nothing`,
    [id, role],
  )

  return id
}

const accountIds = {}
for (const account of DEV_ACCOUNTS.accounts) {
  accountIds[account.role] = await ensureAccount(account)
}
const editorId = accountIds.editor

// ── The questions ────────────────────────────────────────────────────────────
const { mcqs, shorts, untranslated } = buildCorpus()

/** Round-robin across the three levels, so each has a full, usable pool. */
const byLevel = { easy: { mcq: [], short: [] }, medium: { mcq: [], short: [] }, hard: { mcq: [], short: [] } }
mcqs.forEach((q, i) => byLevel[LEVELS[i % 3]].mcq.push(q))
shorts.forEach((q, i) => byLevel[LEVELS[i % 3]].short.push(q))

let created = 0
let skipped = 0

for (const level of LEVELS) {
  const all = [...byLevel[level].mcq, ...byLevel[level].short]

  for (const [index, q] of all.entries()) {
    const externalId = `sample-${level}-${index + 1}`
    const isMcq = q.type === 'mcq'

    /*
     * DRAFT FIRST, TEXTS, THEN PROMOTE.
     *
     * bank_questions_completeness (0054) is a BEFORE INSERT trigger that calls
     * bank_question_missing_locales(new.id) — and on an INSERT no text rows
     * exist yet, so a question created directly as 'active' is refused every
     * time. The editor and bank_import_commit both perform the same three
     * steps, for the same reason.
     */
    const inserted = await db.query(
      `insert into public.bank_questions
         (company_id, brand_id, external_id, difficulty, qtype, topic_id,
          correct_option, status, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,'draft',$8)
       on conflict (company_id, brand_id, external_id) where external_id is not null
       do nothing
       returning id`,
      [
        company.id, brand.id, externalId, level,
        isMcq ? 'mcq' : 'short_answer',
        topics.get(q.topic) ?? null,
        isMcq ? q.correct : null,
        editorId,
      ],
    )

    if (inserted.rowCount === 0) { skipped += 1; continue }
    const id = inserted.rows[0].id

    for (const locale of ['en', 'hi', 'gu']) {
      const t = q[locale]
      await db.query(
        `insert into public.bank_question_texts
           (question_id, brand_id, difficulty, qtype, locale,
            question, option_a, option_b, option_c, option_d, answer_text, explanation)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          id, brand.id, level, isMcq ? 'mcq' : 'short_answer', locale,
          t.q,
          isMcq ? t.a : null, isMcq ? t.b : null, isMcq ? t.c : null, isMcq ? t.d : null,
          isMcq ? null : t.answer,
          isMcq ? null : t.why,
        ],
      )
    }

    await db.query(`update public.bank_questions set status = 'active' where id = $1`, [id])
    created += 1
  }
}

// ── Report ───────────────────────────────────────────────────────────────────
const counts = await db.query(
  `select difficulty, qtype, count(*)::int n
     from public.bank_questions
    where external_id like 'sample-%'
    group by 1,2 order by 1,2`,
)

console.log(`\n  created ${created} questions${skipped ? `, skipped ${skipped} already present` : ''}\n`)
for (const r of counts.rows) {
  console.log(`    ${r.difficulty.padEnd(8)}${r.qtype.padEnd(14)}${r.n}`)
}

const locales = await db.query(
  `select count(*)::int n from public.bank_questions q
    where q.external_id like 'sample-%'
      and (select count(*) from public.bank_question_texts t where t.question_id = q.id) <> 3`,
)
console.log(`\n  questions missing a language: ${locales.rows[0].n}`)

/*
 * Reported, not swallowed. An option with no translation entry prints in
 * English on a Hindi paper — the exact defect the translation table was added
 * to remove — so a gap has to be visible at seed time rather than discovered
 * on a printed exam.
 */
console.log(
  `  untranslated option strings: ${untranslated.length}` +
    (untranslated.length ? ` → ${untranslated.slice(0, 5).join(', ')}` : ''),
)

console.log(`\n  Sample logins — password for all: ${SAMPLE_PASSWORD}`)
for (const a of DEV_ACCOUNTS.accounts) {
  console.log(`    ${a.email.padEnd(32)} ${a.label.padEnd(12)} ${a.can}`)
}
console.log(`\n  /en/login shows these as one-tap buttons in development.`)
console.log(`  Generate a paper at /en/papers/generate.\n`)

await db.end()
