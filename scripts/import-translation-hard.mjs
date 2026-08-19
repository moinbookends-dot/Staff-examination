/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Add a translated locale to the HARD tier — the export shape that
 * import-translation.mjs cannot read.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ A SECOND IMPORTER, BECAUSE THE FIRST ONE FAILS SILENTLY HERE.             │
 * │                                                                           │
 * │ import-translation.mjs is wired to the EASY export. Run against Hard it   │
 * │ does not error — it reads every MCQ as having NO options and never sees   │
 * │ a single short answer:                                                    │
 * │                                                                           │
 * │                    Easy export            Hard/Medium export              │
 * │   block            class="q-block"        …and class="q-block sa-block"   │
 * │   options          <div>A. …</div>        <span class="opt-label">A)</…>  │
 * │   MCQ key          .ak-item letter grid   .answer-grid, 5 cells per row   │
 * │   short-answer key .answer/.explanation   .sa-answer-block                │
 * │                                                                           │
 * │ Easy and Medium translations are already live behind that script, so it   │
 * │ is left frozen rather than parameterised — the same rule written at the   │
 * │ head of parse-aiko-medium.mjs and parse-aiko-hard.mjs. The parsing half   │
 * │ below is COPIED from parse-aiko-hard.mjs and the database half from       │
 * │ import-translation.mjs, rather than retyped; retyping a function from     │
 * │ memory is how 0039 silently lost a set_config call.                       │
 * └───────────────────────────────────────────────────────────────────────────┘
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
 * │ absent from the payload is DELETED. An earlier version of the Easy        │
 * │ importer re-sent only English and the new locale, and importing Gujarati  │
 * │ therefore deleted all 1,023 Hindi rows imported an hour before. The run   │
 * │ reported "1023 updated" and succeeded.                                    │
 * │                                                                           │
 * │ So the texts are read back from the DATABASE, all locales, and the new    │
 * │ one replaces its own locale and nothing else. That also makes this script │
 * │ safe to run twice, and safe to run for a third language later.            │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE TRANSLATED KEY'S LETTER MUST EQUAL THE BANK'S correct_option.        │
 * │                                                                           │
 * │ import-translation.mjs only checks that the named option EXISTS in the    │
 * │ translation, which a re-ordered export passes. Its own header box records │
 * │ why that is not enough: the first translation export agreed with English  │
 * │ on 267/1000 answers, which is chance, and importing it by position would  │
 * │ have marked ~73% of questions against another question's answer.          │
 * │                                                                           │
 * │ The Hard exports carry a per-question letter in the answer grid, so that  │
 * │ agreement can be CHECKED rather than assumed. It is a hard failure here.  │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHY THE 17 AUG EXPORTS WERE PARSED BUT NOT IMPORTED.                      │
 * │                                                                           │
 * │ Residual English — the share of strings still containing a Latin word of  │
 * │ three or more letters — measured on the parsed content:                   │
 * │                                                                           │
 * │                        stems                options                       │
 * │     Easy    (live)     152/1023   15%       12/3972    0.3%               │
 * │     Medium  (live)     348/1030   34%      407/4000     10%               │
 * │     Hard    (held)     931/1030   90%     1154/4000     29%               │
 * │                                                                           │
 * │ The residue is sentence scaffolding, not stray proper nouns — the(453),   │
 * │ does(371), which(338), chef(331), has(216), fails(183). A typical stem    │
 * │ reads "A chef's <dish> has the <fault> '<value>'. <section> મુજબ સેક્શન,  │
 * │ ઉકેલ શું છે?" — English grammar carrying Gujarati nouns. Hindi is         │
 * │ degraded identically, so it is the generator and not the language.        │
 * │                                                                           │
 * │ Everything else about those files checks out: 1030 blocks, 1000/1000      │
 * │ letter agreement with the bank, no blank options, every string inside     │
 * │ 0054's CHECK constraints. So they are parseable and were deliberately     │
 * │ NOT applied, pending a re-export at Easy-level quality.                   │
 * │                                                                           │
 * │ This script reports that measurement on every run, beside the live Easy   │
 * │ and Medium figures, so a re-export can be judged before it is written.    │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 *   node scripts/import-translation-hard.mjs --lang gu \
 *     --paper "C:/…/AIKO_Hard_Paper_Gujarati.html" \
 *     --key   "C:/…/AIKO_Hard_AnswerKey_Gujarati.html"      # verify only
 *
 *   …same command with --apply                               # write
 *
 *   --difficulty easy|medium|hard   which slice of the bank to match against
 *                                   (default hard; Medium shares this markup)
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
const DIFFICULTY = arg('difficulty', 'hard')
const BATCH = 100

if (!LANG || !PAPER || !KEY) {
  console.error('\n  --lang, --paper and --key are all required\n')
  process.exit(2)
}
if (!['en', 'hi', 'gu'].includes(LANG)) {
  console.error(`\n  --lang must be en, hi or gu — got "${LANG}"\n`)
  process.exit(2)
}
if (!['easy', 'medium', 'hard'].includes(DIFFICULTY)) {
  console.error(`\n  --difficulty must be easy, medium or hard — got "${DIFFICULTY}"\n`)
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

let problems = 0
const fail = (msg) => {
  problems += 1
  if (problems <= 40) console.log(`    ✗ ${msg}`)
  else if (problems === 41) console.log('    ✗ …further problems suppressed')
}

/*
 * Read as UTF-8 and mean it. Read as Latin-1, "Jalapeño" becomes "JalapeÃ±o" —
 * and every Gujarati and Devanagari character becomes mojibake outright. This
 * throws rather than "repairing", because the repair is indistinguishable from
 * corrupting a file that was always correct.
 */
const read = (path) => {
  const text = readFileSync(path, 'utf-8')
  if (text.includes('Ã') || text.includes('\uFFFD')) {
    throw new Error(`${path} looks mis-encoded. Re-export as UTF-8; do not repair here.`)
  }
  return text
}

const decode = (s) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()

/*
 * Copied from parse-aiko-hard.mjs. The `[^"]*` before the closing quote is
 * load-bearing — short answers are `class="q-block sa-block"`, and a pattern
 * demanding the quote straight after `q-block` does not see the next short
 * answer, so one match swallows every sibling up to the following header. That
 * produced 8 short answers instead of 30 on the Medium run.
 *
 * topic-header stays in the alternation because it TERMINATES the block above
 * it, but its text is discarded: the headings are translated too, and a
 * question's topic comes from the bank row, never from a translated file.
 */
const WALK =
  /<div class="topic-header">([^<]*)<\/div>|<div class="q-block(?: sa-block)?" data-id="([^"]+)">([\s\S]*?)(?=<div class="(?:q-block|topic-header|section-divider)[^"]*"|\s*<\/body>)/g

/** The paper: question text, and for an MCQ its four options in order. */
function parsePaper(html) {
  const out = new Map()
  for (const m of html.matchAll(WALK)) {
    if (m[1] !== undefined) continue // a topic heading; see above
    const [, , externalId, body] = m
    const qText = body.match(/<div class="q-text">([\s\S]*?)<\/div>/)
    if (!qText) continue
    if (out.has(externalId)) fail(`duplicate id in the translated paper: ${externalId}`)
    // The <span class="q-num">Q1.</span> prefix is presentation, not content.
    const question = decode(qText[1]).replace(/^Q?\d+\.\s*/, '')

    const options = {}
    for (const o of body.matchAll(
      /<div class="opt-item"><span class="opt-label">([A-D])\)<\/span>([\s\S]*?)<\/div>/g,
    )) {
      options[o[1]] = decode(o[2])
    }
    out.set(externalId, { question, options: Object.keys(options).length ? options : null })
  }
  return out
}

/**
 * The key. Two shapes in one document:
 *   .answer-grid       five cells per MCQ — Q#, id, letter, the answer's own
 *                      text, explanation
 *   .sa-answer-block   one block per short answer, carrying data-id
 */
function parseKey(html) {
  const out = new Map()

  for (const grid of html.matchAll(
    /<div class="answer-grid">([\s\S]*?)<\/div>\s*<div class="(?:topic-header|section-divider)/g,
  )) {
    const cells = [
      ...grid[1].matchAll(/<div class="answer-cell[^"]*"[^>]*>([\s\S]*?)<\/div>/g),
    ].map((c) => decode(c[1]))
    // Five header cells, then five per question.
    const rows = cells.slice(5)
    if (rows.length % 5 !== 0) {
      fail(`answer grid has ${rows.length} cells after the header, not a multiple of 5`)
    }
    for (let i = 0; i + 4 < rows.length; i += 5) {
      const [, externalId, letter, answerText, explanation] = rows.slice(i, i + 5)
      if (out.has(externalId)) fail(`duplicate id in the translated key: ${externalId}`)
      out.set(externalId, { letter, answerText, explanation: explanation || null })
    }
  }

  for (const m of html.matchAll(
    /<div class="sa-answer-block" data-id="([^"]+)">([\s\S]*?)(?=<div class="(?:sa-answer-block|topic-header)"|\s*<\/body>)/g,
  )) {
    const [, externalId, body] = m
    const answer = body.match(/<div class="sa-answer-text">([\s\S]*?)<\/div>/)
    const expl = body.match(/<div class="sa-explanation">([\s\S]*?)<\/div>/)
    out.set(externalId, {
      letter: null,
      // "Answer:" in English, "उत्तर:" in Hindi, "જવાબ:" in Gujarati.
      answerText: answer ? decode(answer[1]).replace(/^(?:Answer|उत्तर|જવાબ)\s*:\s*/, '') : null,
      explanation: expl ? decode(expl[1]) : null,
    })
  }

  return out
}

async function tokenFor(email) {
  const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      'Content-Type': 'application/json',
    },
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

/** A word of three or more Latin letters — the residual-English measure. */
const latinWords = (s) => (s ?? '').match(/[A-Za-z]{3,}/g) ?? []

const pct = (n, d) => (d === 0 ? '  — ' : `${String(Math.round((n / d) * 100)).padStart(3)}%`)

try {
  await db.connect()

  const paper = parsePaper(read(PAPER))
  const keyBlocks = parseKey(read(KEY))

  const [brand] = (
    await db.query(`select id, name from public.brands where slug = 'aiko' and deleted_at is null`)
  ).rows
  if (!brand) throw new Error('no brand with slug "aiko"')

  /*
   * The bank is the source of truth for everything except the new text —
   * scoped to ONE difficulty. The Easy importer selected the whole bank, which
   * was right when the bank held one tier; with three tiers loaded a Hard run
   * would report the other 2,053 questions as missing a translation and refuse.
   */
  const existing = (
    await db.query(
      `select q.id, q.external_id, q.difficulty, q.qtype, q.status, q.correct_option,
              t.slug topic_slug
         from public.bank_questions q
         join public.question_topics t on t.id = q.topic_id
        where q.deleted_at is null and q.difficulty::text = $1`,
      [DIFFICULTY],
    )
  ).rows
  if (existing.length === 0) throw new Error(`no ${DIFFICULTY} questions in the bank`)

  /*
   * EVERY locale, not just English — see the box at the top of this file.
   * Whatever is not in the payload is deleted by the RPC. Deliberately NOT
   * scoped by difficulty: it is keyed by question_id, and only the rows being
   * written are ever read out of it.
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
  const priorLocales = [...new Set([...priorTexts.values()].flat().map((t) => t.locale))].sort()

  console.log(`\n  ${APPLY ? '*** APPLYING ***' : 'VERIFY ONLY'}\n`)
  console.log(`  locale      ${LANG}`)
  console.log(`  difficulty  ${DIFFICULTY}`)
  console.log(`  paper       ${PAPER.split(/[\\/]/).pop()}`)
  console.log(`  key         ${KEY.split(/[\\/]/).pop()}`)
  console.log(`  in bank     ${existing.length} ${DIFFICULTY} questions`)
  console.log(`  in file     ${paper.size} translated blocks, ${keyBlocks.size} key entries`)
  console.log(
    `  carrying    ${priorLocales.join(', ')} → ${[...new Set([...priorLocales, LANG])]
      .sort()
      .join(', ')}\n`,
  )

  console.log('  Checks')

  const known = new Set(existing.map((q) => q.external_id))
  for (const id of paper.keys()) {
    if (!known.has(id)) fail(`in the translated paper but not in the ${DIFFICULTY} bank: ${id}`)
  }

  const rows = []
  let missingTranslation = 0
  let mcq = 0
  let sa = 0
  let letterAgrees = 0

  for (const q of existing) {
    const tr = paper.get(q.external_id)
    if (!tr) {
      missingTranslation += 1
      continue
    }
    const prior = priorTexts.get(q.id) ?? []
    if (!prior.some((t) => t.locale === 'en')) {
      fail(`${q.external_id} has no English text in the bank`)
    }

    const k = keyBlocks.get(q.external_id)
    if (!k) fail(`${q.external_id} has no entry in the translated key`)

    if (tr.question.length < 3 || tr.question.length > 2000) {
      fail(`${q.external_id}: translated question is ${tr.question.length} chars (3–2000)`)
    }

    if (q.qtype === 'mcq') {
      mcq += 1
      const n = tr.options ? Object.keys(tr.options).length : 0
      if (n !== 4) fail(`${q.external_id} is an MCQ but the translation has ${n} options`)
      for (const [letter, text] of Object.entries(tr.options ?? {})) {
        if (!text) fail(`${q.external_id}: translated option ${letter} is blank`)
      }
      /*
       * The letter the TRANSLATED key names must equal the bank's own
       * correct_option — see the box at the top. Checking only that the option
       * exists passes a re-ordered export.
       */
      if (!k?.letter) {
        fail(`${q.external_id}: MCQ, but the translated key gives no letter`)
      } else if (!/^[A-D]$/.test(k.letter)) {
        fail(`${q.external_id}: translated key letter is "${k.letter}", not A–D`)
      } else if (k.letter !== q.correct_option) {
        fail(
          `${q.external_id}: the bank's answer is ${q.correct_option} but the translated key says ${k.letter}`,
        )
      } else {
        letterAgrees += 1
      }
    } else {
      sa += 1
      if (k?.letter) fail(`${q.external_id} is a short answer but the translated key gives a letter`)
      if (!k?.answerText) fail(`${q.external_id} is a short answer with no model answer in the key`)
      if (k?.answerText && k.answerText.length > 400) {
        fail(`${q.external_id}: model answer is ${k.answerText.length} chars (max 400)`)
      }
    }

    if (k?.explanation && k.explanation.length > 2000) {
      fail(`${q.external_id}: explanation is ${k.explanation.length} chars (max 2000)`)
    }

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
        ...prior
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
          answerText: q.qtype === 'short_answer' ? (k?.answerText ?? null) : null,
          /*
           * Unlike the Easy export, this key carries a translated explanation
           * for MCQs too, in the fifth grid cell. Carried, so a translated
           * answer key does not print a blank line where English has a reason.
           */
          explanation: k?.explanation ?? null,
        },
      ],
    })
  }

  if (missingTranslation) {
    fail(`${missingTranslation} ${DIFFICULTY} bank question(s) have no translated block`)
  }
  if (problems === 0) {
    console.log(
      `    ✓ ${rows.length} matched · ${mcq} mcq + ${sa} short answer · every option present, every string within limits`,
    )
    console.log(`    ✓ the translated key agrees with the bank's answer  ${letterAgrees} / ${mcq}`)
  }

  // ── Residual English, against what is already live ─────────────────────────
  let fileQ = 0
  let fileQLatin = 0
  let fileO = 0
  let fileOLatin = 0
  for (const q of existing) {
    const tr = paper.get(q.external_id)
    if (!tr) continue
    fileQ += 1
    if (latinWords(tr.question).length) fileQLatin += 1
    for (const text of Object.values(tr.options ?? {})) {
      fileO += 1
      if (latinWords(text).length) fileOLatin += 1
    }
  }

  const live = (
    await db.query(
      `select q.difficulty::text tier, t.question, t.option_a, t.option_b, t.option_c, t.option_d
         from public.bank_question_texts t
         join public.bank_questions q on q.id = t.question_id
        where t.locale = $1 and q.deleted_at is null`,
      [LANG],
    )
  ).rows

  const tally = new Map()
  for (const r of live) {
    if (!tally.has(r.tier)) tally.set(r.tier, { q: 0, qL: 0, o: 0, oL: 0 })
    const t = tally.get(r.tier)
    t.q += 1
    if (latinWords(r.question).length) t.qL += 1
    for (const col of ['option_a', 'option_b', 'option_c', 'option_d']) {
      if (r[col] == null) continue
      t.o += 1
      if (latinWords(r[col]).length) t.oL += 1
    }
  }

  const line = (label, qL, q, oL, o) =>
    `    ${label.padEnd(15)}${String(qL).padStart(5)}/${String(q).padEnd(6)}${pct(qL, q)}   ` +
    `${String(oL).padStart(5)}/${String(o).padEnd(6)}${pct(oL, o)}`

  console.log(`\n  Residual English in "${LANG}" — strings still containing a Latin word\n`)
  console.log('                        stems               options')
  for (const tier of ['easy', 'medium', 'hard']) {
    const t = tally.get(tier)
    if (t) console.log(line(`${tier} · live`, t.qL, t.q, t.oL, t.o))
  }
  console.log(line(`${DIFFICULTY} · file`, fileQLatin, fileQ, fileOLatin, fileO))
  console.log('\n    Advisory, never blocking — the bar is a judgement, not a threshold.')

  if (problems > 0) {
    console.log(`\n  ${problems} problem(s) — nothing written.\n`)
    await db.end()
    process.exit(1)
  }

  const carried = [...new Set(rows.flatMap((r) => r.texts.map((t) => t.locale)))].sort()
  console.log(`\n  Ready to write ${rows.length} row(s), each carrying ${carried.join(' + ')}\n`)

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
        select q.difficulty::text tier, t.locale, count(*)::int rows,
               count(*) filter (where t.question is null or t.question = '')::int blank
          from public.bank_question_texts t
          join public.bank_questions q on q.id = t.question_id
         where q.deleted_at is null
         group by 1, 2 order by 1, 2`)
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
