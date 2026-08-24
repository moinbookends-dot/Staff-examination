/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Turn the AIKO MEDIUM question bank HTML into the import format.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ READ-ONLY. Writes ONE file and never touches the database.                ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ SEPARATE FROM parse-aiko.mjs BECAUSE THE MEDIUM EXPORT IS A DIFFERENT    ║
 * ║ DOCUMENT, NOT A LONGER ONE.                                               ║
 * ║                                                                           ║
 * ║ Easy keys its answers with .ak-item; Medium uses a five-column            ║
 * ║ .answer-grid of .answer-cell divs. Easy's paper had no ids at all and had ║
 * ║ to be matched by position; Medium carries data-id on every block — the    ║
 * ║ change that came out of the translation misalignment.                     ║
 * ║                                                                           ║
 * ║ Generalising one parser over both would put the Easy path — already       ║
 * ║ imported, verified, and pinned by import-contract-frozen.test.ts — at     ║
 * ║ risk to save a file. Two parsers, each matching one document.             ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE CHECK EASY COULD NOT DO: THE LETTER IS VERIFIED AGAINST THE TEXT.    ║
 * ║                                                                           ║
 * ║ The Medium key gives the correct answer TWICE — once as a position        ║
 * ║ letter, once as the answer's own words:                                   ║
 * ║                                                                           ║
 * ║   Q1 │ aiko-med-0001 │ A │ "9" │ "Avocado Roll has 9 method steps."       ║
 * ║                                                                           ║
 * ║ So for all 1,000 MCQs this parser reads option A off the PAPER and        ║
 * ║ requires it to equal "9". Two independently generated documents have to   ║
 * ║ agree, which catches a shifted key, a shuffled option block, or an        ║
 * ║ off-by-one — none of which a count would notice.                          ║
 * ║                                                                           ║
 * ║ Easy had no such column and rested on id coverage alone. This is why      ║
 * ║ that import needed a hand-built positional argument and this one does     ║
 * ║ not.                                                                      ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 *   node scripts/parse-aiko-medium.mjs                      # parse, verify
 *   node scripts/parse-aiko-medium.mjs --write out.json
 */

import { readFileSync, writeFileSync } from 'node:fs'

const DOWNLOADS = 'C:/Users/bookends2/Downloads'
const PAPER = process.env.AIKO_PAPER ?? `${DOWNLOADS}/AIKO_Medium_Paper.html`
const KEY = process.env.AIKO_KEY ?? `${DOWNLOADS}/AIKO_Medium_AnswerKey.html`

const writeAt = process.argv.includes('--write')
  ? process.argv[process.argv.indexOf('--write') + 1]
  : null

/*
 * Read as UTF-8 and mean it — the same guard parse-aiko.mjs carries, and for
 * the same reason. A rendering of this export showed "JalapeÃ±o", which is the
 * classic sign of UTF-8 read as Latin-1. Checked against the bytes before
 * writing any repair: the file holds C3 B1, which IS correct UTF-8 for ñ, and
 * "repairing" it would have been the corruption. The mojibake was in the
 * viewer, not the file. This throws only if a file really is mis-encoded.
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

/** Heading as printed → the topic slug the bank stores. */
const TOPIC_SLUGS = {
  'METHOD STEPS': 'method-steps',
  'QUALITY CHECK POINTS': 'quality-checks',
  'KEY INGREDIENTS': 'key-ingredients',
  'COOKING TIME': 'cooking-time',
  'COOKING TEMPERATURE': 'cooking-temperature',
  'HOLDING & STORAGE': 'holding-storage',
  GARNISH: 'garnish',
  'SERVING NOTES': 'serving-notes',
}

const problems = []
const fail = (msg) => problems.push(msg)

// ─────────────────────────────────────────────────────────────────────────────
// The paper: question text, options, topic
// ─────────────────────────────────────────────────────────────────────────────
const paperText = read(PAPER)

/*
 * Walked in DOCUMENT ORDER rather than matched separately, because a question's
 * topic is not written on the question — it is whichever topic-header was last
 * seen above it. Two independent passes would have to re-derive that ordering
 * and could disagree with it.
 */
/*
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE TERMINATOR ALLOWS EXTRA CLASSES, AND MUST.                           │
 * │                                                                           │
 * │ Short answers are `class="q-block sa-block"`. A lookahead written as      │
 * │ `class="(?:q-block|…)"` demands the quote immediately after `q-block`, so │
 * │ it does not see the NEXT short answer and the match runs on until the     │
 * │ following topic-header — swallowing every sibling. That produced exactly  │
 * │ 8 short answers from 30: one per topic, the rest eaten. `[^"]*` before    │
 * │ the quote is what makes a multi-class block a boundary.                   │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
const WALK = /<div class="topic-header">([^<]*)<\/div>|<div class="q-block(?: sa-block)?" data-id="([^"]+)">([\s\S]*?)(?=<div class="(?:q-block|topic-header|section-divider)[^"]*"|\s*<\/body>)/g

const paper = new Map()
let topic = null

for (const m of paperText.matchAll(WALK)) {
  if (m[1] !== undefined) {
    // "METHOD STEPS (255 questions)" → "METHOD STEPS"
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

for (const grid of keyText.matchAll(/<div class="answer-grid">([\s\S]*?)<\/div>\s*<div class="(?:topic-header|section-divider)/g)) {
  const cells = [...grid[1].matchAll(/<div class="answer-cell[^"]*"[^>]*>([\s\S]*?)<\/div>/g)].map((c) =>
    decode(c[1]),
  )
  // Five header cells, then five per question.
  const rows = cells.slice(5)
  if (rows.length % 5 !== 0) fail(`answer grid has ${rows.length} cells after the header, not a multiple of 5`)

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

  // Absent fields are OMITTED, never null — the import contract now reads
  // null as absent, but omitting is what parse-aiko.mjs (easy) always did and
  // it keeps the emitted files canonical.
  questions.push({
    externalId: id,
    difficulty: 'medium',
    type: q.options ? 'mcq' : 'short_answer',
    topic: q.topic,
    ...(q.options ? { correctOption: k.letter } : {}),
    en: {
      question: q.question,
      ...(q.options ? { options: q.options } : { answer: k.answerText }),
      ...(k.explanation ? { explanation: k.explanation } : {}),
    },
  })
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
for (const q of questions) if (q.correctOption) byLetter[q.correctOption] = (byLetter[q.correctOption] ?? 0) + 1
console.log(`  answer spread  ${Object.entries(byLetter).sort().map(([k, v]) => `${k}:${v}`).join('  ')}`)

console.log(`\n  LETTER AGREES WITH THE ANSWER'S OWN TEXT:  ${letterTextAgree} / ${mcq}`)

const untagged = questions.filter((q) => !q.topic).length
const blank = questions.filter((q) => !q.en.question).length
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
