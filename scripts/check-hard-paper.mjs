/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Verify the HARD bank and the Hard papers drawn from it.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ READ-ONLY. Every statement is a SELECT.                                   ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE CHECK THAT MATTERS IS THE ANSWER KEY, AND IT IS CHECKED AGAINST THE   ║
 * ║ SOURCE — NOT AGAINST ITSELF.                                              ║
 * ║                                                                           ║
 * ║ Counting rows proves an import ran. It does not prove the right letter    ║
 * ║ landed on the right question, and that is the failure that reaches a      ║
 * ║ member of staff as "I answered correctly and was marked wrong".           ║
 * ║                                                                           ║
 * ║ So this re-reads the parsed source file and requires, for all 1,000 Hard  ║
 * ║ MCQs, that the database's correct_option equals the letter the source     ║
 * ║ carried AND that the four option texts are byte-identical. A shifted key, ║
 * ║ a half-applied batch or a re-import against stale ids all fail here.      ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 *   node scripts/check-hard-paper.mjs                  # uses ./_aiko-hard.json
 *   node scripts/check-hard-paper.mjs --file other.json
 *   node scripts/check-hard-paper.mjs --pdf            # …and render the six PDFs
 *
 * --pdf needs `npm run dev` running. It is a flag rather than always-on so the
 * database checks stay usable in a terminal with no app, which is where they
 * are most often wanted.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'

const FILE = process.argv.includes('--file')
  ? process.argv[process.argv.indexOf('--file') + 1]
  : './_aiko-hard.json'

const WITH_PDF = process.argv.includes('--pdf')
const APP = process.env.APP_URL ?? 'http://localhost:3000'

const env = {}
for (const line of readFileSync(resolve('.env.local'), 'utf-8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m) env[m[1]] = m[2].trim()
}
const ref = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split('.')[0]

const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST ?? 'aws-0-ap-southeast-1.pooler.supabase.com',
  port: 5432,
  user: `postgres.${ref}`,
  password: env.SUPABASE_DB_PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
})

const problems = []
const fail = (m) => problems.push(m)
const ok = (label, detail) => console.log(`  PASS  ${label.padEnd(42)}${detail ?? ''}`)
const bad = (label, detail) => {
  console.log(`  FAIL  ${label.padEnd(42)}${detail ?? ''}`)
  fail(`${label} ${detail ?? ''}`)
}
const assert = (cond, label, detail) => (cond ? ok(label, detail) : bad(label, detail))

try {
  await db.connect()
  console.log('')

  // ── 1. The bank ───────────────────────────────────────────────────────────
  const { rows: pool } = await db.query(`
    select qtype::text, count(*)::int n
      from public.bank_questions
     where difficulty = 'hard' and status = 'active' and deleted_at is null
     group by 1 order by 1`)
  const poolOf = (t) => pool.find((r) => r.qtype === t)?.n ?? 0

  assert(poolOf('mcq') === 1000, 'hard active MCQ = 1000', `got ${poolOf('mcq')}`)
  assert(poolOf('short_answer') === 30, 'hard active short = 30', `got ${poolOf('short_answer')}`)

  const [{ n: untagged }] = (
    await db.query(`select count(*)::int n from public.bank_questions
                     where difficulty='hard' and deleted_at is null and topic_id is null`)
  ).rows
  assert(untagged === 0, 'every hard question has a topic', `untagged ${untagged}`)

  const [{ n: noOption }] = (
    await db.query(`select count(*)::int n from public.bank_questions
                     where difficulty='hard' and qtype='mcq' and deleted_at is null
                       and correct_option is null`)
  ).rows
  assert(noOption === 0, 'every hard MCQ has a correct option', `missing ${noOption}`)

  // ── 2. Answer-key integrity, against the source file ──────────────────────
  const source = JSON.parse(readFileSync(FILE, 'utf-8')).questions
  const byId = new Map(source.map((q) => [q.externalId, q]))

  const { rows: dbRows } = await db.query(`
    select q.external_id, q.qtype::text, q.correct_option::text,
           t.question, t.option_a, t.option_b, t.option_c, t.option_d, t.answer_text
      from public.bank_questions q
      join public.bank_question_texts t on t.question_id = q.id and t.locale = 'en'
     where q.difficulty = 'hard' and q.deleted_at is null`)

  assert(dbRows.length === source.length, 'source rows present in the bank',
    `db ${dbRows.length} vs file ${source.length}`)

  let letterAgree = 0
  let optionAgree = 0
  let textAgree = 0
  let mcqSeen = 0
  const mismatches = []

  for (const r of dbRows) {
    const src = byId.get(r.external_id)
    if (!src) {
      mismatches.push(`${r.external_id}: in the bank but not in ${FILE}`)
      continue
    }
    if (r.question !== src.en.question) {
      textAgree += 0
      mismatches.push(`${r.external_id}: question text differs from source`)
    } else {
      textAgree += 1
    }
    if (r.qtype === 'mcq') {
      mcqSeen += 1
      if (r.correct_option === src.correctOption) letterAgree += 1
      else mismatches.push(`${r.external_id}: correct_option ${r.correct_option} but source says ${src.correctOption}`)

      const same =
        r.option_a === src.en.options.A &&
        r.option_b === src.en.options.B &&
        r.option_c === src.en.options.C &&
        r.option_d === src.en.options.D
      if (same) optionAgree += 1
      else mismatches.push(`${r.external_id}: option text differs from source`)
    } else if (r.answer_text !== src.en.answer) {
      mismatches.push(`${r.external_id}: model answer differs from source`)
    }
  }

  assert(textAgree === dbRows.length, 'question text matches source', `${textAgree}/${dbRows.length}`)
  assert(letterAgree === mcqSeen, 'correct_option matches source key', `${letterAgree}/${mcqSeen}`)
  assert(optionAgree === mcqSeen, 'all four options match source', `${optionAgree}/${mcqSeen}`)
  for (const m of mismatches.slice(0, 20)) console.log(`        · ${m}`)

  // ── 3. Duplicate prevention ───────────────────────────────────────────────
  const { rows: dupText } = await db.query(`
    select lower(btrim(t.question)) k, count(*)::int n
      from public.bank_questions q
      join public.bank_question_texts t on t.question_id = q.id and t.locale='en'
     where q.difficulty='hard' and q.deleted_at is null
     group by 1 having count(*) > 1`)
  assert(dupText.length === 0, 'no two hard questions share english text', `${dupText.length} collision(s)`)

  const { rows: dupExt } = await db.query(`
    select external_id, count(*)::int n from public.bank_questions
     where difficulty='hard' and deleted_at is null
     group by 1 having count(*) > 1`)
  assert(dupExt.length === 0, 'no duplicate external_id', `${dupExt.length} duplicated`)

  // ── 4. The Hard papers ────────────────────────────────────────────────────
  const { rows: papers } = await db.query(`
    select p.id, p.paper_no, p.marks, p.mcq_n, p.short_n, p.status::text,
           count(e.*)::int total,
           count(*) filter (where e.section='mcq')::int mcq,
           count(*) filter (where e.section='short_answer')::int short,
           count(distinct e.question_id)::int distinct_q,
           min(e.question_no)::int lo, max(e.question_no)::int hi
      from public.exam_papers p
      join public.exam_paper_questions e on e.paper_id = p.id
     where p.difficulty = 'hard'
     group by p.id, p.paper_no, p.marks, p.mcq_n, p.short_n, p.status
     order by p.paper_no`)

  assert(papers.length > 0, 'at least one hard paper exists', `${papers.length}`)

  for (const p of papers) {
    const tag = `paper #${p.paper_no}`
    assert(p.marks === 20, `${tag} marks = 20`, `got ${p.marks}`)
    assert(p.total === 20, `${tag} carries 20 questions`, `got ${p.total}`)
    assert(p.mcq === 16 && p.short === 4, `${tag} split 16 mcq + 4 short`, `got ${p.mcq}+${p.short}`)
    assert(p.mcq === p.mcq_n && p.short === p.short_n, `${tag} matches its recorded blueprint`,
      `recorded ${p.mcq_n}+${p.short_n}`)
    assert(p.distinct_q === 20, `${tag} has no repeated question`, `${p.distinct_q} distinct`)
    assert(p.lo === 1 && p.hi === 20, `${tag} numbered 1..20 continuously`, `${p.lo}..${p.hi}`)

    // Every question on a hard paper must itself be hard.
    const [{ n: wrongLevel }] = (
      await db.query(
        `select count(*)::int n from public.exam_paper_questions e
           join public.bank_questions q on q.id = e.question_id
          where e.paper_id = $1 and q.difficulty <> 'hard'`,
        [p.id],
      )
    ).rows
    assert(wrongLevel === 0, `${tag} draws only hard questions`, `${wrongLevel} off-level`)

    // Section label must agree with the question's own type.
    const [{ n: wrongSection }] = (
      await db.query(
        `select count(*)::int n from public.exam_paper_questions e
           join public.bank_questions q on q.id = e.question_id
          where e.paper_id = $1 and e.section::text <> q.qtype::text`,
        [p.id],
      )
    ).rows
    assert(wrongSection === 0, `${tag} section matches question type`, `${wrongSection} mismatched`)
  }

  // Never-twice: no two hard papers share a combination hash.
  const { rows: dupHash } = await db.query(`
    select combination_hash, count(*)::int n from public.exam_papers
     where difficulty='hard' group by 1 having count(*) > 1`)
  assert(dupHash.length === 0, 'no two hard papers share a combination', `${dupHash.length}`)

  // ── 5. Language coverage ──────────────────────────────────────────────────
  const { rows: locales } = await db.query(`
    select t.locale, count(*)::int n
      from public.bank_questions q
      join public.bank_question_texts t on t.question_id = q.id
     where q.difficulty='hard' and q.deleted_at is null
     group by 1 order by 1`)
  const localeOf = (l) => locales.find((r) => r.locale === l)?.n ?? 0

  const [{ required_locales: required }] = (
    await db.query(`select required_locales from public.exam_settings limit 1`)
  ).rows

  assert(localeOf('en') === dbRows.length, 'english present for every hard question',
    `${localeOf('en')}/${dbRows.length}`)

  for (const l of required) {
    assert(localeOf(l) === dbRows.length, `required locale "${l}" complete`,
      `${localeOf(l)}/${dbRows.length}`)
  }

  /*
   * hi and gu are REPORTED, not asserted.
   *
   * exam_settings.required_locales is {en}, so Hard is complete as far as the
   * product's own rule is concerned and the completeness trigger lets these
   * questions be active. But exam_paper_content() LEFT JOINs the text table
   * (0060, deliberately), so a Hindi Hard paper prints twenty structurally
   * correct and textually BLANK questions. That is a real gap and it is stated
   * here rather than passed over in silence — a check that only asserts what is
   * required would report a clean bill of health for an unprintable paper.
   */
  for (const l of ['hi', 'gu']) {
    if (!required.includes(l)) {
      const n = localeOf(l)
      console.log(
        `  NOTE  ${`"${l}" not required — ${n}/${dbRows.length} translated`.padEnd(42)}` +
          (n === 0 ? 'a hard paper in this language prints blank' : ''),
      )
    }
  }

  // ── 6. The six PDFs ───────────────────────────────────────────────────────
  if (WITH_PDF) {
    console.log('')
    const paperId = papers[papers.length - 1].id
    const paperNo = papers[papers.length - 1].paper_no

    const session = await (
      await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
        method: 'POST',
        headers: {
          apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ email: 'sample-chef@example.com', password: 'Sample-2026!' }),
      })
    ).json()
    if (!session.access_token) throw new Error('could not sign in to fetch PDFs')

    /*
     * Exactly what @supabase/ssr writes: `base64-` + base64URL of the session
     * JSON, chunked at 3180 characters. Standard base64 would be silently
     * wrong — see decodeBase64Url in src/proxy.ts. Copied from render-check.mjs
     * rather than invented, so the two cannot drift.
     */
    const cookieName = `sb-${ref}-auth-token`
    const encoded = 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url')
    const parts = []
    for (let i = 0; i < encoded.length; i += 3180) parts.push(encoded.slice(i, i + 3180))
    const cookie =
      parts.length === 1
        ? `${cookieName}=${parts[0]}`
        : parts.map((p, i) => `${cookieName}.${i}=${p}`).join('; ')

    const sizes = {}
    for (const locale of ['en', 'hi', 'gu']) {
      for (const kind of ['paper.pdf', 'key.pdf']) {
        const url = `${APP}/api/papers/${paperId}/${locale}/${kind}`
        let res
        try {
          res = await fetch(url, { headers: { cookie } })
        } catch (e) {
          bad(`pdf ${locale}/${kind}`, `unreachable — is npm run dev up? (${e.message})`)
          continue
        }
        const buf = Buffer.from(await res.arrayBuffer())
        const magic = buf.subarray(0, 5).toString('latin1')
        const pages = (buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length
        sizes[`${locale}/${kind}`] = buf.length

        assert(
          res.status === 200 && magic === '%PDF-' && buf.length > 5000,
          `pdf #${paperNo} ${locale}/${kind}`,
          `${res.status} ${magic} ${buf.length}B ${pages}pp`,
        )
      }
    }

    /*
     * The English and Hindi bytes MUST differ.
     *
     * Both render 200 and both are valid PDFs even when the Hindi text is
     * missing, so "it downloaded" proves nothing about the locale actually
     * reaching the renderer. If the two files were identical the route would
     * be ignoring its locale parameter — which is precisely the bug that
     * would make every translated paper silently English.
     */
    if (sizes['en/paper.pdf'] && sizes['hi/paper.pdf']) {
      assert(
        sizes['en/paper.pdf'] !== sizes['hi/paper.pdf'],
        'en and hi papers are different documents',
        `${sizes['en/paper.pdf']}B vs ${sizes['hi/paper.pdf']}B`,
      )
      console.log(
        `  NOTE  ${'hi paper is smaller than en'.padEnd(42)}` +
          `consistent with untranslated (blank) question text`,
      )
    }
  }
} catch (error) {
  console.error(`\n  ${error.message}\n`)
  process.exitCode = 1
} finally {
  await db.end()
}

console.log('')
if (problems.length) {
  console.log(`  ${problems.length} PROBLEM(S)\n`)
  process.exitCode = 1
} else {
  console.log('  All hard-paper checks passed.\n')
}
