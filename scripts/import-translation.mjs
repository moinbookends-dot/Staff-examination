/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Add a translated locale to questions that are already in the bank.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ EVERY ROW CARRIES *EVERY LOCALE ALREADY IN THE BANK*, PLUS THE NEW ONE.  │
 * │                                                                           │
 * │ bank_import_commit ends its text block with                               │
 * │                                                                           │
 * │     delete from bank_question_texts                                       │
 * │      where question_id = v_qid and not (locale = any (v_locales))         │
 * │                                                                           │
 * │ — deliberately, so a re-import can retract a bad translation. Anything    │
 * │ absent from the payload is DELETED.                                       │
 * │                                                                           │
 * │ An earlier version of this script re-sent only English and the new        │
 * │ locale. Importing Gujarati therefore deleted all 1,023 Hindi rows that    │
 * │ had been imported an hour before — the payload simply never mentioned     │
 * │ them. Guarding English alone is not enough and the bug is silent: the     │
 * │ run reports "1023 updated" and succeeds.                                  │
 * │                                                                           │
 * │ So the texts are read back from the DATABASE, all locales, and the new    │
 * │ one replaces its own locale and nothing else. That also makes the script  │
 * │ safe to run twice, and safe to run for a third language later.            │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ MATCHED ON data-id, NEVER ON QUESTION NUMBER.                            │
 * │                                                                           │
 * │ The first translation export was numbered 1–1030 in a DIFFERENT order     │
 * │ from the English paper: its answer key agreed with English on 267/1000,   │
 * │ which is chance. Had it been imported by position, ~73% of questions      │
 * │ would have been marked against another question's answer. The export now  │
 * │ carries the English externalId on each block and that is the only thing   │
 * │ this script joins on — a re-ordered file is now harmless.                 │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 *   node scripts/import-translation.mjs --lang hi \
 *     --paper "C:/…/AIKO_Easy_Paper_Hindi_1.html" \
 *     --key   "C:/…/AIKO_Easy_AnswerKey_Hindi_1.html"      # verify only
 *
 *   …same command with --apply                              # write
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import pg from 'pg'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? fallback : process.argv[i + 1]
}
const APPLY = process.argv.includes('--apply')
const LANG = arg('lang')
const PAPER = arg('paper')
const KEY = arg('key')
const BATCH = 100

if (!LANG || !PAPER || !KEY) {
  console.error('\n  --lang, --paper and --key are all required\n')
  process.exit(2)
}

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

/*
 * The same zero-width-lookahead terminator the English parser uses. A lazy
 * `[\s\S]*?</div>` stops at the FIRST closing tag, which for an MCQ is the end
 * of option A — that bug silently dropped option D from all 1,000 English
 * questions on the first pass and is the reason this shape is copied exactly.
 */
const BOUNDARY = '(?=<div class="(?:q-block|topic-header|section-divider|end-doc|footer)")'
const BLOCK = new RegExp(`<div class="q-block" data-id="([^"]+)">([\\s\\S]*?)${BOUNDARY}`, 'g')

const read = (path) => {
  const text = readFileSync(path, 'utf-8')
  if (text.includes('Ã')) {
    throw new Error(`${path} looks mis-encoded (found "Ã"). Re-export as UTF-8; do not repair here.`)
  }
  return text
}

const clean = (html) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()

/** The paper: question text, and for an MCQ its four options in order. */
function parsePaper(html) {
  const out = new Map()
  for (const [, id, body] of html.matchAll(BLOCK)) {
    const qm = body.match(/<div class="q-text">([\s\S]*?)<\/div>/)
    if (!qm) continue
    // Strip the leading "123.  " — the number is display only; data-id is identity.
    const question = clean(qm[1]).replace(/^\d+\.\s*/, '')
    const options = {}
    for (const o of body.matchAll(/<div>([A-D])\.\s*([\s\S]*?)<\/div>/g)) options[o[1]] = clean(o[2])
    out.set(id, { question, options: Object.keys(options).length ? options : null })
  }
  return out
}

/** The answer key: model answers and explanations for the short answers. */
function parseKey(html) {
  const out = new Map()
  for (const [, id, body] of html.matchAll(BLOCK)) {
    const a = body.match(/<div class="answer">([\s\S]*?)<\/div>/)
    const e = body.match(/<div class="explanation">([\s\S]*?)<\/div>/)
    out.set(id, { answer: a ? clean(a[1]) : null, explanation: e ? clean(e[1]) : null })
  }
  // The MCQ half is a flat grid of letters, used only to VERIFY, never to write:
  // correct_option lives once on the language-neutral row.
  const letters = new Map()
  for (const m of html.matchAll(/<div class="ak-item"><b>(\d+)\.<\/b>\s*([A-D])\s*<\/div>/g)) {
    letters.set(Number(m[1]), m[2])
  }
  return { blocks: out, letters }
}

async function tokenFor(email) {
  const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'Sample-2026!' }),
  })
  const body = await res.json()
  if (!body.access_token) throw new Error(`sign-in failed: ${JSON.stringify(body).slice(0, 200)}`)
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

let problems = 0
const fail = (msg) => {
  problems += 1
  console.log(`    ✗ ${msg}`)
}

try {
  await db.connect()

  const paper = parsePaper(read(PAPER))
  const { blocks: keyBlocks } = parseKey(read(KEY))

  const [brand] = (
    await db.query(`select id, name from public.brands where slug = 'aiko' and deleted_at is null`)
  ).rows
  if (!brand) throw new Error('no brand with slug "aiko"')

  /* The bank is the source of truth for everything except the new text. */
  const existing = (
    await db.query(`
      select q.id, q.external_id, q.difficulty, q.qtype, q.status, q.correct_option,
             t.slug topic_slug
        from public.bank_questions q
        join public.question_topics t on t.id = q.topic_id
       where q.deleted_at is null`)
  ).rows

  /*
   * EVERY locale, not just English — see the box at the top of this file.
   * Whatever is not in the payload is deleted by the RPC.
   */
  const priorTexts = new Map()
  for (const t of (
    await db.query(`
      select t.question_id, t.locale, t.question, t.option_a, t.option_b, t.option_c,
             t.option_d, t.answer_text, t.explanation
        from public.bank_question_texts t
        join public.bank_questions q on q.id = t.question_id
       where q.deleted_at is null`)
  ).rows) {
    if (!priorTexts.has(t.question_id)) priorTexts.set(t.question_id, [])
    priorTexts.get(t.question_id).push(t)
  }
  const priorLocales = [
    ...new Set([...priorTexts.values()].flat().map((t) => t.locale)),
  ].sort()

  console.log(`\n  ${APPLY ? '*** APPLYING ***' : 'VERIFY ONLY'}\n`)
  console.log(`  locale      ${LANG}`)
  console.log(`  paper       ${PAPER.split(/[\\/]/).pop()}`)
  console.log(`  key         ${KEY.split(/[\\/]/).pop()}`)
  console.log(`  in bank     ${existing.length} questions`)
  console.log(`  in file     ${paper.size} translated blocks`)
  console.log(`  carrying    ${priorLocales.join(', ')} → ${[...new Set([...priorLocales, LANG])].sort().join(', ')}\n`)

  console.log('  Checks')

  const rows = []
  let missingTranslation = 0
  for (const q of existing) {
    const tr = paper.get(q.external_id)
    if (!tr) {
      missingTranslation += 1
      continue
    }
    const prior = priorTexts.get(q.id) ?? []
    if (!prior.some((t) => t.locale === 'en')) fail(`${q.external_id} has no English text in the bank`)

    if (q.qtype === 'mcq') {
      const n = tr.options ? Object.keys(tr.options).length : 0
      if (n !== 4) fail(`${q.external_id} is an MCQ but the translation has ${n} options`)
      // The option the key names must EXIST in the translated set. correct_option
      // is a position letter, so a translation with fewer options would silently
      // point at nothing.
      if (tr.options && !tr.options[q.correct_option]) {
        fail(`${q.external_id}: correct option ${q.correct_option} is absent from the translation`)
      }
    } else {
      const k = keyBlocks.get(q.external_id)
      if (!k?.answer) fail(`${q.external_id} is a short answer with no model answer in the key`)
      if (k?.answer && k.answer.length > 400) {
        fail(`${q.external_id}: model answer is ${k.answer.length} chars (max 400)`)
      }
    }

    const k = keyBlocks.get(q.external_id) ?? {}
    rows.push({
      externalId: q.external_id,
      difficulty: q.difficulty,
      qtype: q.qtype,
      status: q.status,
      topicSlug: q.topic_slug,
      correctOption: q.qtype === 'mcq' ? q.correct_option : null,
      referenceTitle: null,
      referencePage: null,
      texts: [
        /*
         * Every locale already in the bank, verbatim, EXCEPT the one being
         * imported — which the block below replaces. Omitting any of these
         * deletes it; that is how the Hindi rows were lost once already.
         */
        ...(priorTexts.get(q.id) ?? [])
          .filter((t) => t.locale !== LANG)
          .map((t) => ({
            locale: t.locale,
            question: t.question,
            optionA: t.option_a,
            optionB: t.option_b,
            optionC: t.option_c,
            optionD: t.option_d,
            answerText: t.answer_text,
            explanation: t.explanation,
          })),
        {
          locale: LANG,
          question: tr.question,
          optionA: tr.options?.A ?? null,
          optionB: tr.options?.B ?? null,
          optionC: tr.options?.C ?? null,
          optionD: tr.options?.D ?? null,
          answerText: q.qtype === 'short_answer' ? (k.answer ?? null) : null,
          explanation: q.qtype === 'short_answer' ? (k.explanation ?? null) : null,
        },
      ],
    })
  }

  if (missingTranslation) fail(`${missingTranslation} bank question(s) have no translated block`)
  if (problems === 0) console.log('    ✓ every question matched, every option present, every answer within limits')

  const carried = [...new Set(rows.flatMap((r) => r.texts.map((t) => t.locale)))].sort()
  console.log(`\n  Ready to write ${rows.length} row(s), each carrying ${carried.join(' + ')}\n`)

  if (problems > 0) {
    console.log(`  ${problems} problem(s) — nothing written.\n`)
    process.exitCode = 1
    await db.end()
    process.exit(1)
  }

  if (!APPLY) {
    console.log('  Nothing written. Re-run with --apply\n')
    await db.end()
    process.exit(0)
  }

  const token = await tokenFor('sample-chef@example.com')
  console.log('  Importing')
  let updated = 0
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH)
    const res = await commit(token, brand.id, slice)
    if (res.status !== 200) {
      throw new Error(
        `batch ${i + 1}–${i + slice.length} failed (${res.status}): ${JSON.stringify(res.body).slice(0, 400)}`,
      )
    }
    updated += res.body?.updated ?? 0
    console.log(`    ${String(i + slice.length).padStart(5)} / ${rows.length}`)
  }
  console.log(`\n  Reported: ${updated} updated`)

  // ── What is actually in the database ──────────────────────────────────────
  console.log('\n  Verified against the database\n')
  console.table(
    (
      await db.query(`
        select t.locale, count(*)::int rows,
               count(*) filter (where t.question is null or t.question = '')::int blank
          from public.bank_question_texts t
          join public.bank_questions q on q.id = t.question_id
         where q.deleted_at is null
         group by 1 order by 1`)
    ).rows,
  )

  const [{ n: stillActive }] = (
    await db.query(
      `select count(*)::int n from public.bank_questions where deleted_at is null and status = 'active'`,
    )
  ).rows
  console.log(`  still active: ${stillActive}`)

  const [{ n: lostEnglish }] = (
    await db.query(`
      select count(*)::int n from public.bank_questions q
       where q.deleted_at is null
         and not exists (select 1 from public.bank_question_texts t
                          where t.question_id = q.id and t.locale = 'en')`)
  ).rows
  console.log(`  questions that LOST their English text: ${lostEnglish}`)
  console.log('')
} catch (error) {
  console.error(`\n  ${error.message}\n`)
  process.exitCode = 1
} finally {
  await db.end()
}
