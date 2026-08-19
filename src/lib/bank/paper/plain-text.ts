import { OPTION_KEYS, type OptionKey, type QuestionType } from '../vocabulary'
import { encodingFault } from './decode'
import type {
  ParseIssue,
  ParsedAnswerKey,
  ParsedKeyEntry,
  ParsedPaper,
  ParsedQuestion,
} from './types'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A plain-text paper, for the small hand-made file.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ DELIBERATELY NARROW. IT READS ONE LAYOUT AND SAYS SO.                     │
 * │                                                                           │
 * │ A "smart" text parser that copes with any layout is a parser that guesses,│
 * │ and a guess here writes a wrong answer key into an exam. This one accepts │
 * │ exactly the shape below and refuses anything else by name, which is the   │
 * │ behaviour somebody can correct their file against.                        │
 * │                                                                           │
 * │   Q1. [aiko-hard-0001] The stem, on one line.                             │
 * │   A) first option                                                         │
 * │   B) second option                                                        │
 * │   C) third option                                                         │
 * │   D) fourth option                                                        │
 * │                                                                           │
 * │   Q2. A short answer question with no options.                            │
 * │                                                                           │
 * │ …and for a key, one entry per line:                                       │
 * │                                                                           │
 * │   Q1. [aiko-hard-0001] B                                                  │
 * │   Q2. [aiko-hard-0002] The model answer, as a sentence.                   │
 * │                                                                           │
 * │ The `[…]` is the question's external id. It is OPTIONAL in the syntax and │
 * │ effectively required in practice: without it a block cannot be matched to │
 * │ a question in the bank, which the validator reports per question.         │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** `Q1.` / `1.` / `1)` at the start of a line, with an optional `[id]` after. */
const HEAD = /^\s*(?:Q|प्र|પ્ર)?\s*(\d{1,6})\s*[.)：:]\s*(?:\[([^\]]+)\]\s*)?(.*)$/
/** `A)` / `A.` / `(A)` at the start of a line. */
const OPTION = /^\s*\(?([A-D])\)?\s*[.)]?\s+(.*)$/
/** A lone letter, which is what an MCQ key line reduces to after the head. */
const LETTER = /^\(?([A-D])\)?\.?$/

/** Is this text worth trying? One numbered line is enough to say yes. */
export function looksLikePlainTextPaper(text: string): boolean {
  return text.split(/\r?\n/).some((line) => HEAD.test(line))
}

export function parsePlainTextPaper(raw: string): ParsedPaper {
  const encoding = encodingFault(raw)
  if (encoding) {
    return { format: 'plain-text', questions: [], sections: [], headings: [], fatal: encoding }
  }

  const questions: ParsedQuestion[] = []
  let current: ParsedQuestion | null = null
  let index = 0

  const close = () => {
    if (!current) return
    questions.push(finish(current))
    current = null
  }

  for (const line of raw.split(/\r?\n/)) {
    const head = line.match(HEAD)

    // An option line only counts while a question is open — otherwise "A) …"
    // in a preamble would silently attach itself to nothing.
    if (current) {
      const option = line.match(OPTION)
      if (option && !head) {
        const letter = option[1] as OptionKey
        const text = option[2].trim()

        if (current.options[letter] !== undefined) {
          current.issues.push({
            code: 'repeated-option-label',
            message: `Option ${letter} appears more than once in this question.`,
          })
        } else {
          if (!text) {
            current.issues.push({
              code: 'blank-option',
              message: `Option ${letter} is present but empty.`,
            })
          }
          current.options[letter] = text
        }
        continue
      }
    }

    if (head) {
      close()
      current = {
        externalId: head[2]?.trim() || null,
        number: Number.parseInt(head[1], 10),
        section: null,
        heading: null,
        stem: head[3].trim(),
        options: {},
        detectedType: null,
        marks: null,
        index: index++,
        issues: [],
      }
      continue
    }

    /*
     * A continuation line. Appended rather than dropped, because a wrapped stem
     * is the single most common thing in a hand-typed file and losing its tail
     * would produce a question that is valid, importable and wrong.
     */
    if (current && line.trim()) {
      current.stem = `${current.stem} ${line.trim()}`.trim()
    }
  }
  close()

  if (questions.length === 0) {
    return {
      format: 'plain-text',
      questions: [],
      sections: [],
      headings: [],
      fatal:
        'No questions were found in this file. Each question must begin on its own line with its number, for example "Q1. …", and each option with its letter, for example "A) …".',
    }
  }

  return { format: 'plain-text', questions, sections: [], headings: [] }
}

/** The per-question checks that can only run once the block is complete. */
function finish(question: ParsedQuestion): ParsedQuestion {
  const found = OPTION_KEYS.filter((key) => question.options[key] !== undefined)
  let detectedType: QuestionType | null = null

  if (found.length === 0) detectedType = 'short_answer'
  else if (found.length === OPTION_KEYS.length) detectedType = 'mcq'
  else {
    const missing = OPTION_KEYS.filter((key) => question.options[key] === undefined)
    question.issues.push({
      code: 'partial-options',
      message: `Only ${found.length} of 4 options could be identified — ${missing.join(', ')} ${
        missing.length === 1 ? 'is' : 'are'
      } missing.`,
    })
  }

  if (!question.stem) {
    question.issues.push({ code: 'no-stem', message: 'The question text is empty.' })
  }
  if (!question.externalId) {
    question.issues.push({
      code: 'no-external-id',
      message:
        'This question carries no [id], so it cannot be matched to a question in the bank.',
    })
  }

  return { ...question, detectedType }
}

// ─────────────────────────────────────────────────────────────────────────────
// The key
// ─────────────────────────────────────────────────────────────────────────────

export function parsePlainTextAnswerKey(raw: string): ParsedAnswerKey {
  const encoding = encodingFault(raw)
  if (encoding) return { format: 'plain-text', entries: [], headings: [], fatal: encoding }

  const entries: ParsedKeyEntry[] = []
  let index = 0

  for (const line of raw.split(/\r?\n/)) {
    const head = line.match(HEAD)
    if (!head) continue

    const rest = head[3].trim()
    const letter = rest.match(LETTER)
    const issues: ParseIssue[] = []

    if (!rest) {
      issues.push({
        code: 'no-answer-text',
        message: 'This key line names a question but gives no answer.',
      })
    }
    if (!head[2]) {
      issues.push({ code: 'no-external-id', message: 'This key line carries no [id].' })
    }

    entries.push({
      externalId: head[2]?.trim() || null,
      number: Number.parseInt(head[1], 10),
      // A lone A–D is a multiple-choice answer; anything longer is a model
      // answer. Nothing else is inferred — an ambiguous line becomes a model
      // answer and is reported against the question's type by the validator.
      letter: letter ? (letter[1] as OptionKey) : null,
      answerText: letter ? null : rest || null,
      explanation: null,
      index: index++,
      issues,
    })
  }

  if (entries.length === 0) {
    return {
      format: 'plain-text',
      entries: [],
      headings: [],
      fatal:
        'No answers were found in this file. Each answer must be on its own line, for example "Q1. [aiko-hard-0001] B".',
    }
  }

  return { format: 'plain-text', entries, headings: [] }
}
