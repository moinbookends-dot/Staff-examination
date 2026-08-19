import { OPTION_KEYS, type OptionKey, type QuestionType } from '../vocabulary'
import { decodeHtml, encodingFault } from './decode'
import type {
  ParseIssue,
  ParsedAnswerKey,
  ParsedKeyEntry,
  ParsedPaper,
  ParsedQuestion,
} from './types'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The AIKO export format — question paper and answer key.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE PATTERNS BELOW ARE PORTED, NOT INVENTED, AND EACH ODD-LOOKING DETAIL  ║
 * ║ IS THERE BECAUSE OF A SPECIFIC FAILURE. Read the notes before editing.    ║
 * ║                                                                           ║
 * ║ They come from scripts/import-translation-hard.mjs, which has already     ║
 * ║ imported the Easy and Medium translations successfully. Retyping them     ║
 * ║ from memory is exactly how a working parser becomes a subtly broken one — ║
 * ║ the Medium run found 8 short answers instead of 30 from a single missing  ║
 * ║ `[^"]*`.                                                                  ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * WHAT THE DOCUMENT LOOKS LIKE — a question paper:
 *
 *   <div class="section-divider">…section…</div>
 *   <div class="topic-header">…topic, translated…</div>
 *   <div class="q-block" data-id="aiko-hard-0001">
 *     <div class="q-text"><span class="q-num">Q1.</span> …stem…</div>
 *     <div class="opts-grid">
 *       <div class="opt-item"><span class="opt-label">A)</span> …</div>   × 4
 *     </div>
 *   </div>
 *   <div class="q-block sa-block" data-id="aiko-hard-1001">
 *     <div class="q-text"><span class="q-num">Q1001.</span> …stem…</div>
 *     <div class="sa-answer-space">…placeholder…</div>
 *   </div>
 *
 * …and an answer key, which carries TWO shapes in one document:
 *
 *   <div class="answer-grid">
 *     …five header cells…
 *     <div class="answer-cell">Q1</div>
 *     <div class="answer-cell">aiko-hard-0001</div>
 *     <div class="answer-cell answer-cell-correct">D</div>
 *     <div class="answer-cell" …>…the correct option's own text…</div>
 *     <div class="answer-cell" …>…explanation…</div>
 *   </div>
 *   <div class="sa-answer-block" data-id="aiko-hard-1001">
 *     <div class="q-text">…</div>
 *     <div class="sa-answer-text">…model answer…</div>
 *     <div class="sa-explanation">…</div>
 *   </div>
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE `[^"]*` IN THE TERMINATOR IS LOAD-BEARING. DO NOT "TIDY" IT.          │
 * │                                                                           │
 * │ A short answer is `class="q-block sa-block"`. A terminator demanding the  │
 * │ quote immediately after `q-block` does not recognise the NEXT short       │
 * │ answer as a boundary, so one match swallows every sibling up to the       │
 * │ following heading. That produced 8 short answers instead of 30.           │
 * │                                                                           │
 * │ The lookahead — rather than a closing `</div>` — is the other half: the   │
 * │ blocks nest divs and a JavaScript regex cannot balance them. Terminating  │
 * │ on "the start of the next thing" is the only correct reading, which is    │
 * │ also why `</body>` is in the alternation as the last block's end.         │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ data-id IS OPTIONAL IN THE PATTERN AND REQUIRED IN PRACTICE.              │
 * │                                                                           │
 * │ It was mandatory here, and that was a real defect: a block without one    │
 * │ did not match, so it was not parsed, not counted and not reported. A      │
 * │ document with ten such blocks would say "990 questions detected" and      │
 * │ import cleanly, and the ten missing questions would be discovered by      │
 * │ whoever eventually noticed the bank was short.                            │
 * │                                                                           │
 * │ Matching it optionally means the block is read, counted, and REJECTED by  │
 * │ the validator with a sentence saying it cannot be matched to the bank.    │
 * │ Silence is the one outcome that is never acceptable here.                 │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
const WALK =
  /<div class="section-divider">([\s\S]*?)<\/div>|<div class="topic-header">([\s\S]*?)<\/div>|<div class="q-block(?: sa-block)?"(?: data-id="([^"]*)")?>([\s\S]*?)(?=<div class="(?:q-block|topic-header|section-divider)[^"]*"|\s*<\/body>)/g

const Q_TEXT = /<div class="q-text">([\s\S]*?)<\/div>/
const OPT_ITEM = /<div class="opt-item"><span class="opt-label">([A-D])\)<\/span>([\s\S]*?)<\/div>/g

/** `Q1.` / `Q1001.` / a bare `1.` — the printed number, which people navigate by. */
const Q_NUM = /^Q?\s*(\d{1,6})\s*[.):]?\s*/

/**
 * Marks printed on the block, in any of the three languages.
 *
 * The AIKO export carries none — every question is worth one mark and the paper
 * says so once, in its header. Detected anyway so a format that DOES carry them
 * is not silently flattened, and left null rather than defaulted to 1: a mark
 * total invented by a parser is exactly the kind of plausible wrong number that
 * ends up quoted at somebody.
 */
const MARKS = /[([]\s*(\d{1,3})\s*(?:marks?|अंक|ગુણ)\s*[)\]]/i

/** Cells per question row in the key grid: Q#, id, letter, answer text, why. */
const GRID_STRIDE = 5

/** Is this HTML the AIKO export at all? Cheap, and checked before parsing. */
export function looksLikeAikoHtml(text: string): boolean {
  return (
    /<div class="q-block(?: sa-block)?"/.test(text) ||
    /<div class="answer-grid">/.test(text) ||
    /<div class="sa-answer-block" data-id="/.test(text)
  )
}

/** Does this HTML look like the ANSWER KEY half of the pair? */
export function looksLikeAikoAnswerKey(text: string): boolean {
  return /<div class="answer-grid">/.test(text) || /<div class="sa-answer-block" data-id="/.test(text)
}

/**
 * Everything from `<body>` onwards.
 *
 * The stylesheet declares `.q-block { … }` and `.answer-cell-correct { … }`,
 * neither of which matches the patterns above — they all require `<div class="`.
 * Dropping the head anyway costs nothing and means a future rule written as an
 * attribute selector cannot start matching.
 */
function body(text: string): string {
  const start = text.search(/<body[^>]*>/i)
  return start === -1 ? text : text.slice(start)
}

// ─────────────────────────────────────────────────────────────────────────────
// The paper
// ─────────────────────────────────────────────────────────────────────────────

export function parseAikoPaper(raw: string): ParsedPaper {
  const encoding = encodingFault(raw)
  if (encoding) {
    return { format: 'aiko-html', questions: [], sections: [], headings: [], fatal: encoding }
  }

  const questions: ParsedQuestion[] = []
  const sections: string[] = []
  const headings: string[] = []

  let section: string | null = null
  let heading: string | null = null
  let index = 0

  for (const match of body(raw).matchAll(WALK)) {
    const [, sectionText, headingText, externalId, block] = match

    if (sectionText !== undefined) {
      section = decodeHtml(sectionText) || null
      if (section && !sections.includes(section)) sections.push(section)
      continue
    }

    /*
     * A heading TERMINATES the block above it, which is the reason it is in the
     * walk at all. Its text is recorded for the topic mapper and is never used
     * as a question's topic directly — the headings are translated, and a
     * question's topic comes from the bank. See the box on BankFact in types.ts.
     */
    if (headingText !== undefined) {
      heading = decodeHtml(headingText) || null
      if (heading && !headings.includes(heading)) headings.push(heading)
      continue
    }

    const stemMatch = block.match(Q_TEXT)

    if (!stemMatch) {
      questions.push({
        externalId: externalId || null,
        number: null,
        section,
        heading,
        stem: '',
        options: {},
        detectedType: null,
        marks: null,
        index: index++,
        issues: [
          {
            code: 'unreadable-block',
            message: 'This block carries no question text — its .q-text element is missing.',
          },
        ],
      })
      continue
    }

    const issues: ParseIssue[] = []
    const printed = decodeHtml(stemMatch[1])
    const numberMatch = printed.match(Q_NUM)
    const number = numberMatch ? Number.parseInt(numberMatch[1], 10) : null

    /*
     * The Q-number is presentation. It is kept OFF the stem and carried as its
     * own field, because a stem stored as "Q42. …" prints the wrong number the
     * moment the question is drawn onto a different paper.
     */
    const stem = numberMatch ? printed.slice(numberMatch[0].length).trim() : printed

    if (number === null) {
      issues.push({
        code: 'no-question-number',
        message: 'No question number could be read from this block.',
      })
    }
    if (!stem) {
      issues.push({ code: 'no-stem', message: 'The question text is empty.' })
    }

    const options: Partial<Record<OptionKey, string>> = {}
    for (const option of block.matchAll(OPT_ITEM)) {
      const letter = option[1] as OptionKey
      const text = decodeHtml(option[2])

      if (options[letter] !== undefined) {
        issues.push({
          code: 'repeated-option-label',
          message: `Option ${letter} appears more than once in this block.`,
        })
        continue
      }
      if (!text) {
        issues.push({ code: 'blank-option', message: `Option ${letter} is present but empty.` })
      }
      options[letter] = text
    }

    const found = OPTION_KEYS.filter((key) => options[key] !== undefined)
    let detectedType: QuestionType | null = null

    if (found.length === 0) {
      detectedType = 'short_answer'
    } else if (found.length === OPTION_KEYS.length) {
      detectedType = 'mcq'
    } else {
      /*
       * The case the brief names: "Question 42 — could not confidently identify
       * option C". NEITHER type is claimed, so nothing downstream can quietly
       * treat a three-option block as a valid MCQ.
       */
      const missing = OPTION_KEYS.filter((key) => options[key] === undefined)
      issues.push({
        code: 'partial-options',
        message: `Only ${found.length} of 4 options could be identified — ${missing.join(', ')} ${
          missing.length === 1 ? 'is' : 'are'
        } missing.`,
      })
    }

    if (!externalId) {
      issues.push({
        code: 'no-external-id',
        message:
          'This block carries no data-id, so it cannot be matched to a question in the bank.',
      })
    }

    const marks = block.match(MARKS)

    questions.push({
      externalId: externalId || null,
      number,
      section,
      heading,
      stem,
      options,
      detectedType,
      marks: marks ? Number.parseInt(marks[1], 10) : null,
      index: index++,
      issues,
    })
  }

  if (questions.length === 0) {
    return {
      format: 'aiko-html',
      questions: [],
      sections,
      headings,
      fatal:
        'No questions were found in this file. It is HTML, but it contains no question blocks in the format this importer reads.',
    }
  }

  return { format: 'aiko-html', questions, sections, headings }
}

// ─────────────────────────────────────────────────────────────────────────────
// The answer key
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The MCQ grid.
 *
 * Terminated on the next heading rather than on `</div>`, for the same nesting
 * reason as the block walk: the grid's own cells are divs.
 */
const ANSWER_GRID =
  /<div class="answer-grid">([\s\S]*?)(?=<div class="(?:topic-header|section-divider)"|\s*<\/body>)/g
const ANSWER_CELL = /<div class="answer-cell[^"]*"[^>]*>([\s\S]*?)<\/div>/g

const SA_BLOCK =
  /<div class="sa-answer-block" data-id="([^"]+)">([\s\S]*?)(?=<div class="(?:sa-answer-block|topic-header|section-divider)"|\s*<\/body>)/g
const SA_ANSWER = /<div class="sa-answer-text">([\s\S]*?)<\/div>/
const SA_EXPLANATION = /<div class="sa-explanation">([\s\S]*?)<\/div>/

/** "Answer:" in English, and its Hindi and Gujarati equivalents. */
const ANSWER_PREFIX = /^(?:Answer|उत्तर|જવાબ)\s*:\s*/

export function parseAikoAnswerKey(raw: string): ParsedAnswerKey {
  const encoding = encodingFault(raw)
  if (encoding) return { format: 'aiko-html', entries: [], headings: [], fatal: encoding }

  const entries: ParsedKeyEntry[] = []
  const headings: string[] = []
  const text = body(raw)
  let index = 0

  for (const heading of text.matchAll(/<div class="topic-header">([\s\S]*?)<\/div>/g)) {
    const label = decodeHtml(heading[1])
    if (label && !headings.includes(label)) headings.push(label)
  }

  for (const grid of text.matchAll(ANSWER_GRID)) {
    const cells = [...grid[1].matchAll(ANSWER_CELL)].map((cell) => decodeHtml(cell[1]))
    // Five header cells, then five per question.
    const rows = cells.slice(GRID_STRIDE)

    if (rows.length % GRID_STRIDE !== 0) {
      /*
       * Reported, and the grid is still read up to its last COMPLETE row.
       * Truncating silently is what turns "the key is one cell short" into "the
       * last forty answers are shifted by one", which is undetectable by eye
       * and reaches a candidate as a wrong mark.
       */
      entries.push({
        externalId: null,
        number: null,
        letter: null,
        answerText: null,
        explanation: null,
        index: index++,
        issues: [
          {
            code: 'grid-not-multiple-of-five',
            message: `An answer grid has ${rows.length} cells after its header, which is not a whole number of ${GRID_STRIDE}-cell rows. Entries after the break may be shifted.`,
          },
        ],
      })
    }

    for (let i = 0; i + (GRID_STRIDE - 1) < rows.length; i += GRID_STRIDE) {
      const [printed, externalId, letter, , explanation] = rows.slice(i, i + GRID_STRIDE)
      const issues: ParseIssue[] = []

      if (!externalId) {
        issues.push({ code: 'no-external-id', message: 'This key row names no question id.' })
      }

      const known = (OPTION_KEYS as readonly string[]).includes(letter)
      if (!letter) {
        issues.push({ code: 'no-answer-letter', message: 'This key row gives no answer letter.' })
      } else if (!known) {
        /*
         * Carried as NO letter plus an issue, rather than as the raw string, so
         * the validator can report "the key says E — this question has A, B, C,
         * D" instead of letting a non-letter reach a typed field.
         */
        issues.push({
          code: 'no-answer-letter',
          message: `The key gives "${letter}", which is not one of A, B, C or D.`,
        })
      }

      const numberMatch = printed?.match(Q_NUM)

      entries.push({
        externalId: externalId || null,
        number: numberMatch ? Number.parseInt(numberMatch[1], 10) : null,
        letter: known ? (letter as OptionKey) : null,
        answerText: null,
        explanation: explanation || null,
        index: index++,
        issues,
      })
    }
  }

  for (const block of text.matchAll(SA_BLOCK)) {
    const [, externalId, inner] = block
    const answer = inner.match(SA_ANSWER)
    const explanation = inner.match(SA_EXPLANATION)
    const printed = inner.match(Q_TEXT)
    const numberMatch = printed ? decodeHtml(printed[1]).match(Q_NUM) : null

    const answerText = answer ? decodeHtml(answer[1]).replace(ANSWER_PREFIX, '') : null
    const issues: ParseIssue[] = []

    if (!answerText) {
      issues.push({
        code: 'no-answer-text',
        message: 'This short-answer key block carries no model answer.',
      })
    }

    entries.push({
      externalId,
      number: numberMatch ? Number.parseInt(numberMatch[1], 10) : null,
      letter: null,
      answerText,
      explanation: explanation ? decodeHtml(explanation[1]) || null : null,
      index: index++,
      issues,
    })
  }

  if (entries.length === 0) {
    return {
      format: 'aiko-html',
      entries: [],
      headings,
      fatal:
        'No answers were found in this file. It is HTML, but it contains neither an answer grid nor any short-answer key blocks.',
    }
  }

  return { format: 'aiko-html', entries, headings }
}
