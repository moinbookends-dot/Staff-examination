/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Turn the AIKO HARD question bank HTML into the import format.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ READ-ONLY. Writes ONE file and never touches the database.                ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ A THIRD PARSER, THOUGH HARD'S MARKUP IS MEDIUM'S EXACTLY.                 ║
 * ║                                                                           ║
 * ║ Checked before writing rather than assumed: parse-aiko-medium.mjs was run ║
 * ║ against the Hard export unchanged and read all 1,030 questions, matched   ║
 * ║ every id across both documents and agreed with the key 1000/1000. The     ║
 * ║ ONLY thing it could not do was name the topics.                          ║
 * ║                                                                           ║
 * ║ So the honest options were to parameterise Medium or to copy it. Copying  ║
 * ║ wins for one reason: Medium's 1,030 questions are already imported and    ║
 * ║ live, and its parser is the record of how they were produced. Editing it  ║
 * ║ to serve a second document puts a verified import at risk of a regression ║
 * ║ that would not surface until somebody re-ran it. The duplication is       ║
 * ║ ~120 lines and buys a frozen Medium path.                                ║
 * ║                                                                           ║
 * ║ The same argument is written at the head of parse-aiko-medium.mjs about   ║
 * ║ Easy. This is that rule applied a second time, not a new one.            ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ HARD'S TOPICS ARE NOT MEDIUM'S, AND ARE DELIBERATELY NOT MAPPED ONTO      ║
 * ║ THEM.                                                                     ║
 * ║                                                                           ║
 * ║ Two of the five look like existing slugs and are not the same thing:      ║
 * ║                                                                           ║
 * ║   Medium "QUALITY CHECK POINTS"  asks which QC points a dish has.         ║
 * ║   Hard   "QC REASONING"          asks what a FAILED QC point implies.     ║
 * ║                                                                           ║
 * ║   Medium "METHOD STEPS"          asks what step 4 is.                     ║
 * ║   Hard   "METHOD REASONING"      asks WHY step 4 is done that way.        ║
 * ║                                                                           ║
 * ║ Folding recall and reasoning into one slug would erase the distinction    ║
 * ║ the whole easy/medium/hard scheme rests on, and would do it silently —    ║
 * ║ the counts would still add up. Five new slugs, reported as unknown by the ║
 * ║ importer until somebody creates them on purpose.                          ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 *   node scripts/parse-aiko-hard.mjs                      # parse, verify
 *   node scripts/parse-aiko-hard.mjs --write out.json
 *
 * Sources (override with AIKO_PAPER / AIKO_KEY):
 *   AIKO_Hard_Paper.html      Section A = 1000 MCQ, Section B = 30 short answer
 *   AIKO_Hard_AnswerKey.html  .answer-grid for A, .sa-answer-block for B
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { readFileSync, writeFileSync } from 'node:fs'

const DOWNLOADS = 'C:/Users/bookends2/Downloads'
const PAPER = process.env.AIKO_PAPER ?? `${DOWNLOADS}/AIKO_Hard_Paper.html`
const KEY = process.env.AIKO_KEY ?? `${DOWNLOADS}/AIKO_Hard_AnswerKey.html`

const writeAt = process.argv.includes('--write')
  ? process.argv[process.argv.indexOf('--write') + 1]
  : null

/*
 * Read as UTF-8 and mean it — the guard both sibling parsers carry.
 *
 * The Hard export contains "Jalapeño" and "180°C". Read as Latin-1 those become
 * "JalapeÃ±o" and "180Â°C", and importing that would put mangled dish names in
 * front of staff. This throws rather than "repairing", because the repair is
 * indistinguishable from corrupting a file that was always correct.
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

/**
 * Heading as printed → the topic slug the bank stores.
 *
 * These five slugs do NOT exist in question_topics yet. The importer reports an
 * unknown topic rather than creating one (see src/lib/bank/import/format.ts),
 * so they must be created deliberately before this file will load. That is the
 * intended order: a topic vocabulary is a decision, not a side effect of an
 * import.
 */
const TOPIC_SLUGS = {
  'FAULTS & FIXES': 'faults-fixes',
  'QC REASONING': 'qc-reasoning',
  'CROSS-COMPARISON': 'cross-comparison',
  'METHOD REASONING': 'method-reasoning',
  TROUBLESHOOTING: 'troubleshooting',
}

const problems = []
const fail = (msg) => problems.push(msg)

// ─────────────────────────────────────────────────────────────────────────────
// The paper: question text, options, topic
// ─────────────────────────────────────────────────────────────────────────────
const paperText = read(PAPER)

/*
 * Walked in DOCUMENT ORDER: a question's topic is not written on the question,
 * it is whichever topic-header was last seen above it.
 *
 * The `[^"]*` before the closing quote in the terminator is load-bearing —
 * short answers are `class="q-block sa-block"`, and a pattern demanding the
 * quote straight after `q-block` does not see the next short answer, so one
 * match swallows every sibling up to the following header. That produced 8
 * short answers instead of 30 on the Medium run.
 */
const WALK =
  /<div class="topic-header">([^<]*)<\/div>|<div class="q-block(?: sa-block)?" data-id="([^"]+)">([\s\S]*?)(?=<div class="(?:q-block|topic-header|section-divider)[^"]*"|\s*<\/body>)/g

const paper = new Map()
let topic = null

for (const m of paperText.matchAll(WALK)) {
  if (m[1] !== undefined) {
    // "FAULTS & FIXES (200 questions)" → "FAULTS & FIXES"
    const heading = m[1].replace(/\s*\(\d+ questions?\)\s*$/, '').trim()
    topic = TOPIC_SLUGS[heading] ?? null
    if (!topic) fail(`unknown topic heading: "${heading}"`)
    continue
  }

  const [, , externalId, body] = m
  if (paper.has(externalId)) fail(`duplicate id in paper: ${externalId}`)

  const qText = body.match(/<div class="q-text">([\s\S]*?)<\/div>/)
  if (!qText) {
    fail(`${externalId}: no question text`)
    continue
  }
  // The <span class="q-num">Q1.</span> prefix is presentation, not content.
  const question = decode(qText[1]).replace(/^Q\d+\.\s*/, '')

  const options = {}
  for (const o of body.matchAll(
    /<div class="opt-item"><span class="opt-label">([A-D])\)<\/span>([\s\S]*?)<\/div>/g,
  )) {
    options[o[1]] = decode(o[2])
  }

  const n = Object.keys(options).length
  const isMcq = n > 0
  if (isMcq && n !== 4) fail(`${externalId}: ${n} options, expected 4`)

  paper.set(externalId, { externalId, topic, question, options: isMcq ? options : null })
}

// ─────────────────────────────────────────────────────────────────────────────
// The key: correct letter, the correct answer's own text, explanation
// ─────────────────────────────────────────────────────────────────────────────
const keyText = read(KEY)
const key = new Map()

for (const grid of keyText.matchAll(
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
    if (key.has(externalId)) fail(`duplicate id in key: ${externalId}`)
    if (!/^[A-D]$/.test(letter)) fail(`${externalId}: correct option is "${letter}", not A–D`)
    key.set(externalId, { letter, answerText, explanation })
  }
}

// Short answers carry their own block rather than a grid row.
for (const m of keyText.matchAll(
  /<div class="sa-answer-block" data-id="([^"]+)">([\s\S]*?)(?=<div class="(?:sa-answer-block|topic-header)"|\s*<\/body>)/g,
)) {
  const [, externalId, body] = m
  const answer = body.match(/<div class="sa-answer-text">([\s\S]*?)<\/div>/)
  const expl = body.match(/<div class="sa-explanation">([\s\S]*?)<\/div>/)
  if (!answer) {
    fail(`${externalId}: short answer has no model answer`)
    continue
  }
  key.set(externalId, {
    letter: null,
    answerText: decode(answer[1]).replace(/^Answer:\s*/, ''),
    explanation: expl ? decode(expl[1]) : null,
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Cross-verification — the point of the exercise
// ─────────────────────────────────────────────────────────────────────────────
for (const id of paper.keys()) if (!key.has(id)) fail(`in paper but not in key: ${id}`)
for (const id of key.keys()) if (!paper.has(id)) fail(`in key but not in paper: ${id}`)

let letterTextAgree = 0
let mcq = 0
let sa = 0

const questions = []

for (const [id, q] of paper) {
  const k = key.get(id)
  if (!k) continue

  if (q.options) {
    mcq += 1
    if (!k.letter) {
      fail(`${id}: paper has options but the key gives no letter`)
      continue
    }
    const chosen = q.options[k.letter]
    if (chosen === undefined) {
      fail(`${id}: key says ${k.letter} but the paper has no option ${k.letter}`)
    } else if (chosen === k.answerText) {
      letterTextAgree += 1
    } else {
      fail(
        `${id}: key says ${k.letter} = "${k.answerText}" but option ${k.letter} on the paper is "${chosen}"`,
      )
    }
  } else {
    sa += 1
    if (k.letter) fail(`${id}: short answer but the key gives a letter`)
    if (!k.answerText) fail(`${id}: short answer with no model answer`)
  }

  questions.push({
    externalId: id,
    difficulty: 'hard',
    type: q.options ? 'mcq' : 'short_answer',
    topic: q.topic,
    correctOption: q.options ? k.letter : null,
    en: {
      question: q.question,
      options: q.options,
      answer: q.options ? null : k.answerText,
      explanation: k.explanation || null,
    },
  })
}

/*
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE CHECK THE SIBLING PARSERS DO NOT DO: COLLIDING ENGLISH TEXT.          ║
 * ║                                                                           ║
 * ║ 0054 carries a unique index on (brand, difficulty, lower(btrim(english))). ║
 * ║ Two Hard questions with byte-identical English are therefore not a        ║
 * ║ warning, they are a row the database will REFUSE mid-import — after the   ║
 * ║ rows before it have been written.                                         ║
 * ║                                                                           ║
 * ║ Hard is where this matters. Its questions are generated from a small set  ║
 * ║ of templates over a fixed dish list — "A chef notices 'Roll loose' while  ║
 * ║ preparing X" appears for many X — so near-collisions are everywhere by    ║
 * ║ construction and an exact collision is a plausible generator slip rather  ║
 * ║ than a freak event. Easy and Medium were phrased dish-first and never ran ║
 * ║ that risk, which is why neither parser looks for it.                      ║
 * ║                                                                           ║
 * ║ Found here, it costs one regeneration. Found by Postgres, it costs a      ║
 * ║ half-written import somebody has to unpick.                               ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */
const byEnglish = new Map()
for (const q of questions) {
  const dedupeKey = q.en.question.trim().toLowerCase()
  const seen = byEnglish.get(dedupeKey)
  if (seen) {
    fail(`identical English text — 0054 will refuse one of these: ${seen} and ${q.externalId}\n      "${q.en.question}"`)
  } else {
    byEnglish.set(dedupeKey, q.externalId)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Report
// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n  paper        ${PAPER}`)
console.log(`  key          ${KEY}`)
console.log(`\n  parsed       ${questions.length}  (${mcq} mcq + ${sa} short answer)`)

const byTopic = {}
for (const q of questions) {
  byTopic[q.topic] ??= { mcq: 0, short_answer: 0 }
  byTopic[q.topic][q.type] += 1
}
console.table(byTopic)

const byLetter = {}
for (const q of questions) {
  if (q.correctOption) byLetter[q.correctOption] = (byLetter[q.correctOption] ?? 0) + 1
}
console.log(
  `  answer spread  ${Object.entries(byLetter)
    .sort()
    .map(([k, v]) => `${k}:${v}`)
    .join('  ')}`,
)

console.log(`\n  LETTER AGREES WITH THE ANSWER'S OWN TEXT:  ${letterTextAgree} / ${mcq}`)

const untagged = questions.filter((q) => !q.topic).length
const blank = questions.filter((q) => !q.en.question).length
console.log(`  distinct english  ${byEnglish.size} / ${questions.length}`)
console.log(`  untagged       ${untagged}`)
console.log(`  blank question ${blank}`)

if (problems.length) {
  console.log(`\n  ${problems.length} PROBLEM(S):\n`)
  for (const p of problems.slice(0, 40)) console.log(`    ${p}`)
  if (problems.length > 40) console.log(`    …and ${problems.length - 40} more`)
  console.log('\n  Nothing written.\n')
  process.exit(1)
}

console.log('\n  All checks passed.\n')

if (writeAt) {
  writeFileSync(writeAt, JSON.stringify({ questions }, null, 2), 'utf-8')
  console.log(`  wrote ${writeAt}\n`)
}
