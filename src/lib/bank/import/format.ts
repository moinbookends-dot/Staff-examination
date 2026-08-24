import { z } from 'zod'
import {
  ANSWER_MAX_LENGTH,
  BANK_LOCALES,
  QUESTION_MAX_LENGTH,
  QUESTION_MIN_LENGTH,
  difficultySchema,
  optionKeySchema,
  questionStatusSchema,
  questionTypeSchema,
} from '../vocabulary'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE IMPORT CONTRACT — the shape the 3,000-question dataset must arrive in.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THIS FILE IS THE SPECIFICATION. Generate the dataset against it.          ║
 * ║                                                                           ║
 * ║ The questions are being written outside this application and imported     ║
 * ║ later, so this schema is the entire agreement between the two halves.     ║
 * ║ Everything it accepts will load; everything it rejects is reported per    ║
 * ║ row with the row number and the reason, before anything is written.       ║
 * ║                                                                           ║
 * ║ scripts/import-template.mjs writes a worked example next to this.         ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ JSON, NOT CSV, AND THE REASON IS THE THREE LANGUAGES.                     │
 * │                                                                           │
 * │ A trilingual MCQ has 3 × (1 question + 4 options + 1 explanation) = 18    │
 * │ text fields. As CSV that is an 18-column row where every cell may contain │
 * │ commas, quotes and newlines, in three scripts — and a single mis-escaped  │
 * │ Devanagari cell silently shifts every column after it.                    │
 * │                                                                           │
 * │ JSON nests, so a question is one object and the languages are named       │
 * │ rather than positional. It is also what a generation process naturally    │
 * │ emits.                                                                    │
 * │                                                                           │
 * │ THREE SHAPES ARE ACCEPTED so no reformatting is needed:                   │
 * │   · { "questions": [ … ] }   — the canonical envelope                     │
 * │   · [ … ]                    — a bare array                               │
 * │   · one JSON object per line — JSON Lines, for streamed generation        │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Bumped only if the shape changes incompatibly. Absent is treated as 1. */
export const IMPORT_FORMAT_VERSION = 1

const trimmed = z.string().trim()

/**
 * One language of one question.
 *
 * `options` and `answer` are both optional HERE and checked against the
 * question's type afterwards — so a row that supplies options for a short
 * answer gets "a short answer must not have options", not a schema error
 * about an unexpected key.
 */
export const importTextSchema = z
  .object({
    question: trimmed
      .min(QUESTION_MIN_LENGTH, 'The question is too short.')
      .max(QUESTION_MAX_LENGTH, `The question is longer than ${QUESTION_MAX_LENGTH} characters.`),

    options: z
      .object({
        A: trimmed.min(1).max(500),
        B: trimmed.min(1).max(500),
        C: trimmed.min(1).max(500),
        D: trimmed.min(1).max(500),
      })
      .optional(),

    answer: trimmed
      .min(1)
      .max(ANSWER_MAX_LENGTH, `The answer is longer than ${ANSWER_MAX_LENGTH} characters.`)
      .optional(),

    /** Why the answer is right. Marker-facing; never printed for a candidate. */
    explanation: trimmed.max(2000).optional(),
  })
  .strict()

export type ImportText = z.infer<typeof importTextSchema>

/**
 * One question, in every language supplied.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ ENGLISH IS REQUIRED; hi AND gu ARE NOT.                                   │
 * │                                                                           │
 * │ Not because translations are optional in the product — a paper is printed │
 * │ in every required language — but because the required SET is a per-company│
 * │ setting (exam_settings.required_locales) that starts at {en}. Enforcing   │
 * │ three here would hard-code a rule the database deliberately made          │
 * │ configurable, and would refuse a perfectly good English-first dataset.    │
 * │                                                                           │
 * │ A row missing a required language imports as a DRAFT and is reported in   │
 * │ the summary, rather than failing the whole file.                          │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export const importQuestionSchema = z
  .object({
    /**
     * Your own identifier, carried through so a re-import updates rather than
     * duplicates.
     *
     * Optional, but strongly recommended for a 3,000-row dataset: without it
     * the only way to recognise a question already imported is its English
     * text, so fixing a typo and re-importing creates a second question
     * instead of correcting the first.
     */
    externalId: trimmed.max(100).optional(),

    difficulty: difficultySchema,
    type: questionTypeSchema,

    /**
     * ┌───────────────────────────────────────────────────────────────────────┐
     * │ DEFAULTS TO 'active', AND IS DOWNGRADED RATHER THAN REJECTED.         │
     * │                                                                       │
     * │ The dataset is curated before it arrives, so the common case is a row  │
     * │ that is ready to use — defaulting to 'draft' would import 3,000        │
     * │ unusable questions and require a bulk activation nobody asked for.     │
     * │                                                                       │
     * │ The risk of that default is real and is handled elsewhere: a row       │
     * │ claiming 'active' while missing a language the company REQUIRES is     │
     * │ silently downgraded to draft by the importer and counted in the        │
     * │ report, because the database trigger would refuse it outright and      │
     * │ losing the row over a missing translation helps nobody.                │
     * │                                                                       │
     * │ 'archived' is accepted so an export can round-trip, but it is not      │
     * │ expected in a generated dataset.                                       │
     * └───────────────────────────────────────────────────────────────────────┘
     */
    status: questionStatusSchema.default('active'),

    /** Topic slug or display name. Unknown topics are reported, not created. */
    topic: trimmed.max(80).optional(),

    /** MCQ only. The POSITION of the correct option — never its text. */
    correctOption: optionKeySchema.optional(),

    /** Optional citation. `document` is matched against the library by title. */
    reference: z
      .object({
        document: trimmed.max(300).optional(),
        page: z.number().int().min(1).max(10_000).optional(),
      })
      .strict()
      .optional(),

    en: importTextSchema,
    hi: importTextSchema.optional(),
    gu: importTextSchema.optional(),
  })
  .strict()

export type ImportQuestion = z.infer<typeof importQuestionSchema>

export const importEnvelopeSchema = z.object({
  formatVersion: z.number().int().optional(),
  /** Brand slug. May instead be chosen once, in the UI, at import time. */
  brand: trimmed.max(80).optional(),
  questions: z.array(z.unknown()),
})

/**
 * Why a row was rejected, as a category rather than only a sentence.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ CATEGORIES EXIST SO A 3,000-ROW REPORT IS ACTIONABLE.                     │
 * │                                                                           │
 * │ "412 rows rejected" followed by 412 sentences is not a report, it is a    │
 * │ log. "380 invalid option structure, 22 unknown topic, 10 invalid          │
 * │ difficulty" tells the person which ONE thing to fix in their generator to │
 * │ recover most of the file — and at this scale that is the difference       │
 * │ between one more run and a dozen.                                         │
 * │                                                                           │
 * │ Each row still carries its full sentences; the category is in addition.   │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export const REJECTION_REASONS = [
  'malformed',
  'invalid-difficulty',
  'invalid-type',
  'invalid-status',
  'missing-english',
  'invalid-option-structure',
  'invalid-answer',
  'unknown-topic',
  /* Matches a question already in the bank, but calls it the other type. */
  'type-conflict',
  'invalid-reference',
] as const

export type RejectionReason = (typeof REJECTION_REASONS)[number]

export interface ShapeIssue {
  reason: RejectionReason
  message: string
}

/**
 * Type/shape rules that span fields, checked after the schema so the messages
 * can name the actual problem.
 *
 * Returns every problem rather than the first: somebody fixing a generator
 * needs the whole list, or they run the import five times.
 */
export function shapeIssues(question: ImportQuestion): ShapeIssue[] {
  const issues: ShapeIssue[] = []

  for (const locale of BANK_LOCALES) {
    const text = question[locale]
    if (!text) continue

    if (question.type === 'mcq') {
      if (!text.options) {
        issues.push({
          reason: 'invalid-option-structure',
          message: `${locale}: an MCQ needs all four options.`,
        })
      }
      if (text.answer) {
        issues.push({
          reason: 'invalid-answer',
          message: `${locale}: an MCQ must not have an answer field — use options and correctOption.`,
        })
      }
    } else {
      if (!text.answer) {
        issues.push({ reason: 'invalid-answer', message: `${locale}: a short answer needs an answer.` })
      }
      if (text.options) {
        issues.push({
          reason: 'invalid-option-structure',
          message: `${locale}: a short answer must not have options.`,
        })
      }
    }
  }

  if (question.type === 'mcq' && !question.correctOption) {
    issues.push({
      reason: 'invalid-option-structure',
      message: 'An MCQ needs correctOption — one of A, B, C or D.',
    })
  }
  if (question.type === 'short_answer' && question.correctOption) {
    issues.push({
      reason: 'invalid-option-structure',
      message: 'A short answer must not have correctOption.',
    })
  }

  if (question.reference?.page && !question.reference.document) {
    issues.push({
      reason: 'invalid-reference',
      message: 'A reference page needs a reference document.',
    })
  }

  return issues
}

/**
 * Classify a schema failure by which field it landed on.
 *
 * Zod reports a path; this turns that into one of the categories above so the
 * summary can group by cause. Anything unrecognised is 'malformed', which is
 * the honest answer for a row that is not shaped like a question at all.
 */
export function classifySchemaIssue(path: readonly PropertyKey[]): RejectionReason {
  const head = String(path[0] ?? '')
  const tail = path.map(String)

  if (head === 'difficulty') return 'invalid-difficulty'
  if (head === 'type') return 'invalid-type'
  if (head === 'status') return 'invalid-status'
  if (head === 'correctOption') return 'invalid-option-structure'
  if (head === 'reference') return 'invalid-reference'
  if (head === 'en' && tail.length === 1) return 'missing-english'
  if (tail.includes('options')) return 'invalid-option-structure'
  if (tail.includes('answer')) return 'invalid-answer'
  if (head === 'en' || head === 'hi' || head === 'gu') return 'malformed'

  return 'malformed'
}

/**
 * Read a null-valued field as an absent field, recursively.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ PART OF THE CONTRACT: `"answer": null` MEANS "NO ANSWER".                 │
 * │                                                                           │
 * │ Generators that transpose a spreadsheet or an answer-key column write     │
 * │ null for the cells a row does not have — every MCQ arrives with           │
 * │ `"answer": null`, every short answer with `"options": null`. Zod's        │
 * │ .optional() accepts undefined and not null, so without this step those    │
 * │ rows fail schema parsing with "expected string, received null" — which    │
 * │ is how a 1,000-MCQ file imported zero rows while its 30 short answers     │
 * │ (whose generator omitted the keys instead) sailed through.                │
 * │                                                                           │
 * │ Stripping nulls BEFORE the schema is a widening, not a weakening: every   │
 * │ file that validated before validates identically, the cross-field rules   │
 * │ in shapeIssues() still refuse an MCQ without options, and a REQUIRED      │
 * │ field set to null is still rejected — as "missing", which is what null    │
 * │ meant all along.                                                          │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export function pruneNulls(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value

  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null) continue
    out[key] = pruneNulls(entry)
  }
  return out
}

/** Normalise a topic name or slug for matching. "Food Safety" → "food-safety". */
export function topicSlug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/**
 * The key used to spot two identical questions.
 *
 * Mirrors the unique index in 0054 — (brand, difficulty, lower(btrim(english
 * question))) — so a file that passes this check will not be refused by the
 * database for a duplicate it could have reported first.
 */
export function dedupeKey(question: ImportQuestion): string {
  return questionKey(question.difficulty, question.en.question)
}

/**
 * The key that identifies one question within a brand.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE SAME EXPRESSION THE DATABASE'S UNIQUE INDEX USES.                     │
 * │                                                                           │
 * │ bank_question_texts_dedupe_uq is (brand_id, difficulty,                   │
 * │ lower(btrim(question))) WHERE locale = 'en'. Anything this key treats as  │
 * │ the same question, the index refuses as a duplicate — so matching on it   │
 * │ means the report and the database can never reach different answers.      │
 * │                                                                           │
 * │ NOT the question TYPE, deliberately: the index does not include it. A key │
 * │ that did would call a type-changed row new, and the insert that followed  │
 * │ would hit the very constraint the match exists to avoid.                  │
 * │                                                                           │
 * │ NFC because two encodings of one accented word are one question to a      │
 * │ reader. 0080 normalises the same way on the SQL side.                     │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export function questionKey(difficulty: string, english: string): string {
  return `${difficulty}::${english.normalize('NFC').trim().toLowerCase()}`
}
