/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Turn the AIKO question-bank HTML into the import format.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ READ-ONLY. Writes ONE file and never touches the database.                ║
 * ║                                                                           ║
 * ║ It exists because the alternative was transcribing a thousand questions   ║
 * ║ by hand. In an exam bank a transcription slip does not look like a bug —  ║
 * ║ it looks like a member of staff getting a question wrong. A parser can be ║
 * ║ checked; a thousand manual copies cannot.                                 ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 *   node scripts/parse-aiko.mjs                     # parse, verify, report
 *   node scripts/parse-aiko.mjs --write out.json    # …and emit the import file
 *
 * Sources (override with AIKO_PAPER / AIKO_KEY):
 *   AIKO_Easy_Paper.html      Section A = MCQ, Section B = short answer
 *   AIKO_Easy_AnswerKey.html  .ak-item grid for A, .q-block/.answer for B
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { readFileSync, writeFileSync } from 'node:fs'

const DOWNLOADS = 'C:/Users/bookends2/Downloads'
const PAPER = process.env.AIKO_PAPER ?? `${DOWNLOADS}/AIKO_Easy_Paper.html`
const KEY = process.env.AIKO_KEY ?? `${DOWNLOADS}/AIKO_Easy_AnswerKey.html`

const writeAt = process.argv.includes('--write')
  ? process.argv[process.argv.indexOf('--write') + 1]
  : null

/*
 * Read as UTF-8 and mean it.
 *
 * A paste of an earlier export showed "JalapeÃ±o" — the classic sign of UTF-8
 * bytes read as Latin-1. Checked against the actual bytes before writing any
 * repair: the files hold C3 B1, which IS correct UTF-8 for ñ. So there is
 * nothing to fix and a "fix" would have broken it. This assertion keeps that
 * honest: if an export ever really is mojibake, it stops here rather than
 * importing a thousand questions with mangled dish names.
 */
const read = (path) => {
  const text = readFileSync(path, 'utf-8')
  if (text.includes('Ã')) {
    throw new Error(`${path} looks mis-encoded (found "Ã"). Re-export as UTF-8; do not repair here.`)
  }
  return text
}

const decode = (s) =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()

/**
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ EVERY BLOCK ENDS ON A LOOKAHEAD, AND THE FIRST VERSION DID NOT.          │
 * │                                                                           │
 * │ It was `([\s\S]*?)</div>\s*</div>`, which looks reasonable and is wrong.  │
 * │ Every MCQ block ends:                                                     │
 * │                                                                           │
 * │     <div>D. MSG</div>                                                     │
 * │     </div></div>                                                          │
 * │                                                                           │
 * │ …so the earliest `</div>\s*</div>` the lazy match can find is D's OWN     │
 * │ closing tag paired with the grid's. The capture stopped at "<div>D. MSG"  │
 * │ and option D vanished from all 1,000 questions — including the ~250 whose │
 * │ keyed answer IS D, which would have made them unanswerable.               │
 * │                                                                           │
 * │ A lookahead consumes nothing. `section-divider` is in the list because    │
 * │ Q1000 is followed by one — omit it and the last MCQ swallows Section B.   │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
const BOUNDARY = '(?=<div class="(?:q-block|topic-header|end-doc|section-divider|footer)")'
const TOKEN = new RegExp(
  `<div class="topic-header">([\\s\\S]*?)<\\/div>` +
    `|<div class="section-divider">([\\s\\S]*?)<\\/div>` +
    `|<div class="q-block">([\\s\\S]*?)${BOUNDARY}`,
  'g',
)

/** "ALLERGENS (505 Questions)" → "ALLERGENS" */
const sectionName = (raw) => decode(raw).replace(/\s*\(\d[\d,]*\s+Questions?\)\s*$/i, '')

/** Pull the numbered question text and any A–D options out of one block. */
function readBlock(block) {
  const qText = /<div class="q-text">([\s\S]*?)<\/div>/.exec(block)
  if (!qText) throw new Error(`a q-block has no q-text:\n${block.slice(0, 200)}`)

  const numbered = /^\s*(\d+)\.\s*(.+)$/s.exec(decode(qText[1]))
  if (!numbered) throw new Error(`q-text is not "N. text": ${decode(qText[1]).slice(0, 120)}`)

  const options = {}
  // Tolerant of a missing closing tag: matches the opening div and the text up
  // to the next '<'. Belt and braces alongside the lookahead above.
  for (const m of block.matchAll(/<div>\s*([A-D])\.\s*([^<]*)/g)) {
    options[m[1]] = decode(m[2])
  }

  const answer = /<div class="answer">([\s\S]*?)<\/div>/.exec(block)
  const explanation = /<div class="explanation">([\s\S]*?)<\/div>/.exec(block)

  return {
    no: Number(numbered[1]),
    question: numbered[2],
    options,
    answer: answer ? decode(answer[1]) : null,
    explanation: explanation ? decode(explanation[1]) : null,
  }
}

// ── The paper ────────────────────────────────────────────────────────────────

const questions = []
let section = null

for (const m of read(PAPER).matchAll(TOKEN)) {
  if (m[1] !== undefined) {
    section = sectionName(m[1])
  } else if (m[2] !== undefined) {
    // A section divider does not change the topic; it only separates A from B.
    // The type is derived from whether a block HAS options, never from this.
  } else {
    const b = readBlock(m[3])
    questions.push({
      no: b.no,
      section,
      question: b.question,
      options: b.options,
      // THE SHAPE IS THE TYPE. A block with four options is an MCQ; one with
      // none is a short answer. Trusting the SECTION heading instead would
      // mean a mis-filed block imports as the wrong type and fails the
      // database's bank_question_texts_shape check with no idea why.
      type: Object.keys(b.options).length > 0 ? 'mcq' : 'short_answer',
    })
  }
}

// ── The answer key ───────────────────────────────────────────────────────────

const keyText = read(KEY)

const mcqAnswers = new Map()
for (const m of keyText.matchAll(/<div class="ak-item"><b>(\d+)\.<\/b>\s*([A-D])\s*<\/div>/g)) {
  mcqAnswers.set(Number(m[1]), m[2])
}

const shortAnswers = new Map()
for (const m of keyText.matchAll(new RegExp(`<div class="q-block">([\\s\\S]*?)${BOUNDARY}`, 'g'))) {
  const b = readBlock(m[1])
  if (b.answer) shortAnswers.set(b.no, { answer: b.answer, explanation: b.explanation })
}

// ── Verification, before anything is emitted ─────────────────────────────────

const problems = []
const say = (label, value) => console.log(`  ${String(value).padStart(6)}  ${label}`)

const mcq = questions.filter((q) => q.type === 'mcq')
const short = questions.filter((q) => q.type === 'short_answer')

console.log('\n  Parsed\n')
say('blocks in the paper', questions.length)
say('…multiple choice', mcq.length)
say('…short answer', short.length)
say('MCQ answers in the key', mcqAnswers.size)
say('short answers in the key', shortAnswers.size)

if (mcq.length !== mcqAnswers.size) {
  problems.push(`${mcq.length} MCQs but ${mcqAnswers.size} MCQ answers`)
}
if (short.length !== shortAnswers.size) {
  problems.push(`${short.length} short answers but ${shortAnswers.size} in the key`)
}

// Numbering must be contiguous and unique across the whole paper.
const seen = new Set()
for (const q of questions) {
  if (seen.has(q.no)) problems.push(`question number ${q.no} appears twice`)
  seen.add(q.no)
}
const highest = Math.max(...seen)
for (let n = 1; n <= highest; n++) {
  if (!seen.has(n)) problems.push(`question ${n} is missing`)
}

for (const q of questions) {
  if (q.question.length < 3) problems.push(`Q${q.no} text is shorter than 3 characters`)
  if (q.question.length > 2000) problems.push(`Q${q.no} text exceeds 2000 characters`)
  if (!q.section) problems.push(`Q${q.no} sits under no topic heading`)

  if (q.type === 'mcq') {
    const letters = Object.keys(q.options).sort().join('')
    if (letters !== 'ABCD') problems.push(`Q${q.no} has options "${letters}", expected ABCD`)
    for (const [letter, text] of Object.entries(q.options)) {
      if (!text) problems.push(`Q${q.no} option ${letter} is empty`)
      if (text.length > 500) problems.push(`Q${q.no} option ${letter} exceeds 500 characters`)
    }
    const a = mcqAnswers.get(q.no)
    if (!a) problems.push(`Q${q.no} has no answer in the key`)
    else if (!q.options[a]) problems.push(`Q${q.no} is keyed ${a}, which it does not offer`)
  } else {
    const a = shortAnswers.get(q.no)
    if (!a) problems.push(`Q${q.no} (short answer) has no model answer in the key`)
    else {
      // 400 is a CHECK constraint, not a style guide — the model answer is a
      // marking guide a chef reads at a glance, not an essay.
      if (a.answer.length > 400) {
        problems.push(`Q${q.no} model answer is ${a.answer.length} chars, limit is 400`)
      }
      if (a.answer.length < 1) problems.push(`Q${q.no} model answer is empty`)
      if (a.explanation && a.explanation.length > 2000) {
        problems.push(`Q${q.no} explanation exceeds 2000 characters`)
      }
    }
  }
}

console.log('\n  Topics\n')
const byTopic = new Map()
for (const q of questions) {
  const k = `${q.section} · ${q.type}`
  byTopic.set(k, (byTopic.get(k) ?? 0) + 1)
}
for (const [name, n] of [...byTopic].sort()) say(name, n)

/*
 * DUPLICATE ENGLISH TEXT IS A HARD STOP, NOT A WARNING.
 *
 * bank_question_texts_dedupe_uq is UNIQUE on (brand, difficulty,
 * lower(btrim(question))) and bank_import_commit is atomic — so ONE duplicate
 * does not import 1,029 and skip one, it refuses all 1,030 with an error that
 * does not name the culprit. Finding them here is a two-minute fix instead of
 * an afternoon.
 */
console.log('\n  Duplicates\n')
const byText = new Map()
for (const q of questions) {
  const k = q.question.toLowerCase()
  if (!byText.has(k)) byText.set(k, [])
  byText.get(k).push(q.no)
}
const dupes = [...byText.entries()].filter(([, nos]) => nos.length > 1)

/*
 * RESOLVE THE LETTER TO ITS OPTION TEXT BEFORE COMPARING.
 *
 * The first version compared the raw key values, so an MCQ answered "B" and a
 * short answer of "Hot" looked like a contradiction — and it reported all
 * seven duplicate pairs as disagreeing when every one of them agrees. That is
 * a false alarm on the most alarming line in the report, which is worse than
 * no check: it would have sent somebody hunting for seven wrong answers that
 * do not exist. What a duplicate pair actually shares is the SUBSTANCE of the
 * answer, so that is what gets compared.
 */
const substanceOf = (no) => {
  const q = questions.find((x) => x.no === no)
  if (q?.type === 'mcq') {
    const letter = mcqAnswers.get(no)
    return (q.options[letter] ?? letter ?? '?').toLowerCase()
  }
  return (shortAnswers.get(no)?.answer ?? '?').toLowerCase()
}

say('questions sharing identical English text', dupes.length)
for (const [text, nos] of dupes.slice(0, 20)) {
  const shown = nos.map((n) => {
    const q = questions.find((x) => x.no === n)
    return `Q${n}(${q?.type === 'mcq' ? mcqAnswers.get(n) : 'short'})=${substanceOf(n)}`
  })
  const agree = new Set(nos.map(substanceOf)).size === 1
  console.log(`     ${agree ? 'same answer ' : 'DISAGREE   '} ${shown.join('  ')}`)
  console.log(`                 ${text.slice(0, 88)}`)
}
if (dupes.length > 20) console.log(`     …and ${dupes.length - 20} more`)

const contradictions = dupes.filter(([, nos]) => new Set(nos.map(substanceOf)).size > 1)
say('…whose answers genuinely DISAGREE', contradictions.length)

/*
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHEN A QUESTION IS ASKED BOTH WAYS, THE MCQ IS THE ONE THAT GOES.        │
 * │                                                                           │
 * │ Seven questions appear word-for-word as an MCQ in Section A and again as  │
 * │ a short answer in Section B. Every pair AGREES, so this is redundancy     │
 * │ rather than a data error — but bank_question_texts_dedupe_uq is UNIQUE on │
 * │ lower(btrim(question)) per brand+difficulty REGARDLESS OF TYPE, and       │
 * │ bank_import_commit is atomic. Left alone, seven rows refuse all 1,030.    │
 * │                                                                           │
 * │ The short answer survives because short answers are the scarce resource:  │
 * │ thirty of them against a thousand MCQs, and every 20-mark paper needs     │
 * │ FOUR. Dropping seven MCQs from a thousand costs nothing; dropping seven   │
 * │ short answers would cost a quarter of the pool that makes papers possible │
 * │ at all.                                                                   │
 * │                                                                           │
 * │ A pair that DISAGREED would not be resolvable this way and is still a     │
 * │ hard stop below — silently keeping one of two contradictory answers is    │
 * │ how a candidate gets marked wrong for being right.                        │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
const dropped = new Set()
for (const [, nos] of dupes) {
  if (new Set(nos.map(substanceOf)).size > 1) continue // handled as a problem below
  const shortOnes = nos.filter((n) => questions.find((q) => q.no === n)?.type === 'short_answer')
  // Keep every short answer and one representative overall; drop the rest.
  const keep = shortOnes.length > 0 ? shortOnes[0] : nos[0]
  for (const n of nos) if (n !== keep) dropped.add(n)
}

if (dropped.size > 0) {
  console.log('')
  say('duplicates dropped (the MCQ side of each pair)', dropped.size)
  console.log(`         ${[...dropped].map((n) => `Q${n}`).join(', ')}`)
}

if (contradictions.length > 0) {
  problems.push(
    `${contradictions.length} duplicate question(s) whose answers disagree — resolve these by hand`,
  )
}

// ── Samples ──────────────────────────────────────────────────────────────────

console.log('\n  Samples — check these against the PDF\n')
for (const no of [1, 505, 506, 1000, 1001, 1030]) {
  const q = questions.find((x) => x.no === no)
  if (!q) continue
  console.log(`  Q${no}  [${q.section} · ${q.type}]`)
  console.log(`    ${q.question}`)
  if (q.type === 'mcq') {
    const a = mcqAnswers.get(no)
    for (const l of ['A', 'B', 'C', 'D']) {
      console.log(`      ${l === a ? '►' : ' '} ${l}. ${q.options[l]}`)
    }
  } else {
    const a = shortAnswers.get(no)
    console.log(`      ► ${a?.answer}`)
    if (a?.explanation) console.log(`        (${a.explanation})`)
  }
  console.log('')
}

// ── Emit ─────────────────────────────────────────────────────────────────────

if (problems.length > 0) {
  console.log('  PROBLEMS — nothing will be written:\n')
  for (const p of problems.slice(0, 40)) console.log(`    ${p}`)
  if (problems.length > 40) console.log(`    …and ${problems.length - 40} more`)
  console.log('')
  process.exit(1)
}

console.log('  Every check passed.\n')

if (!writeAt) {
  console.log('  Nothing written. Re-run with --write <path> to emit the import file.\n')
  process.exit(0)
}

/**
 * Section heading → topic slug.
 *
 * KEYED UPPERCASE because that is what the markup contains — the headings read
 * "ALLERGENS (505 Questions)" literally, not lowercase styled uppercase by CSS.
 * The first version keyed them in title case, matched nothing, and emitted
 * 1,000 questions with `topic: undefined` — harmless in itself (topic is
 * optional) but it would have imported the whole bank untagged, making every
 * filter on /questions useless.
 *
 * Both wordings appear across exports, so both are mapped rather than the
 * generator being asked to change.
 */
const TOPIC = {
  ALLERGENS: 'allergens',
  'SERVING TEMPERATURE': 'serving-temperature',
  PORTIONS: 'portions',
  'PORTIONS & PIECE COUNTS': 'portions',
  DIETARY: 'dietary',
  'DIETARY CLASSIFICATION': 'dietary',
  'DISH TYPE': 'dish-type',
  'MENU SECTIONS': 'menu-sections',
}

const payload = {
  formatVersion: 1,
  questions: questions
    .filter((q) => !dropped.has(q.no))
    .sort((a, b) => a.no - b.no)
    .map((q) => {
      const slug = TOPIC[q.section?.toUpperCase()]
      // Refuse rather than emit an untagged bank — see the note above.
      if (!slug) throw new Error(`no topic slug mapped for section "${q.section}"`)

      const base = {
        // Zero-padded so a lexical sort matches a numeric one, and stable
        // across re-imports: this id is what tells a correction from a new
        // question.
        externalId: `aiko-easy-${String(q.no).padStart(4, '0')}`,
        difficulty: 'easy',
        type: q.type,
        topic: slug,
      }

      if (q.type === 'mcq') {
        return { ...base, correctOption: mcqAnswers.get(q.no), en: { question: q.question, options: q.options } }
      }

      const a = shortAnswers.get(q.no)
      return {
        ...base,
        en: {
          question: q.question,
          answer: a.answer,
          ...(a.explanation ? { explanation: a.explanation } : {}),
        },
      }
    }),
}

writeFileSync(writeAt, JSON.stringify(payload, null, 2) + '\n', 'utf-8')
console.log(`  Wrote ${payload.questions.length} questions to ${writeAt}\n`)
