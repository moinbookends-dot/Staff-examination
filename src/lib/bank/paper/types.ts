import type {
  BankLocale,
  Difficulty,
  OptionKey,
  QuestionStatus,
  QuestionType,
} from '../vocabulary'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The shapes a question PAPER moves through, from a file on somebody's desk to
 * a row bank_import_commit() will accept.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THIS IS A DIFFERENT JOB FROM src/lib/bank/import/, AND THE DIFFERENCE IS  ║
 * ║ WORTH STATING BEFORE ANYTHING ELSE IN THIS DIRECTORY IS READ.             ║
 * ║                                                                           ║
 * ║ import/ reads a CURATED JSON FILE that already speaks the contract:       ║
 * ║ every field is named, every language is nested, and a row that does not   ║
 * ║ parse is a generator bug.                                                 ║
 * ║                                                                           ║
 * ║ paper/ reads a DOCUMENT MEANT FOR HUMAN EYES — the same HTML that gets    ║
 * ║ printed and handed to a candidate. Nothing in it was written to be        ║
 * ║ machine-read. So the job is not "validate a contract", it is "recover     ║
 * ║ structure, and be explicit about every place recovery was uncertain".     ║
 * ║                                                                           ║
 * ║ Hence `issues` on the parsed shapes and `warnings` on the prepared one.   ║
 * ║ A parser that quietly returned its best guess would be the worst possible ║
 * ║ design here: a shifted answer key reaches a member of staff as "I         ║
 * ║ answered correctly and was marked wrong", months later, with no trail.    ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Everything in this directory is PURE — no database, no network, no DOM. It
 * runs unchanged in the browser (where the file is read, because a 1 MB Server
 * Action body cannot hold it) and in vitest (where it is tested against the
 * real 1,030-question export).
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────────────────────────────────────────────────────
// Formats
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The document layouts this importer can read.
 *
 * `aiko-html` is the export produced by the question-generation process — the
 * Easy, Medium and Hard papers and their answer keys all share it. It is
 * deliberately named after the format and not after a language: the same markup
 * carries English, Hindi and Gujarati, and a parser keyed on language would
 * have to be written three times.
 *
 * PDF is ABSENT ON PURPOSE. Nothing in this repository extracts text from a
 * PDF — `pdf-to-img` rasterises and `@react-pdf/renderer` writes — and no
 * extractor available here handles Devanagari conjuncts reliably. A file picker
 * that accepted .pdf and produced mangled Hindi would be worse than one that
 * refuses it in a sentence.
 */
export const PAPER_FORMATS = ['aiko-html', 'plain-text'] as const
export type PaperFormat = (typeof PAPER_FORMATS)[number]

/** Which half of the pair a file is. Detected, then confirmed by the person. */
export const PAPER_ROLES = ['paper', 'answer-key'] as const
export type PaperRole = (typeof PAPER_ROLES)[number]

// ─────────────────────────────────────────────────────────────────────────────
// What the parser recovered
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Something the parser could not do confidently.
 *
 * Carried per block rather than aggregated, so the preview can put the warning
 * next to the question it is about — "Q42 · could not identify option C" is
 * actionable where "1 option problem" is not.
 */
export interface ParseIssue {
  /** Stable, for grouping and for translation. Never shown raw. */
  code: ParseIssueCode
  /** Already a sentence. The UI adds the question number, not the wording. */
  message: string
}

export const PARSE_ISSUE_CODES = [
  'no-external-id',
  'no-question-number',
  'no-stem',
  'partial-options',
  'blank-option',
  'repeated-option-label',
  'unreadable-block',
  'grid-not-multiple-of-five',
  'no-answer-letter',
  'no-answer-text',
] as const
export type ParseIssueCode = (typeof PARSE_ISSUE_CODES)[number]

/** One question block, exactly as the document carried it. */
export interface ParsedQuestion {
  /**
   * The document's own identifier — `data-id` in the Aiko export, which is the
   * SAME string as bank_questions.external_id. This is the entire reason a
   * re-import updates instead of duplicating, and why a translated paper can be
   * matched to an English question it shares no words with.
   */
  externalId: string | null
  /** The printed "Q42." number. Presentation, but people navigate by it. */
  number: number | null
  /** The `section-divider` in force. Translated text; advisory only. */
  section: string | null
  /** The `topic-header` in force. Translated text; advisory only — see below. */
  heading: string | null
  stem: string
  /** Only the labels actually found. A partial set is an issue, not a fill-in. */
  options: Partial<Record<OptionKey, string>>
  /**
   * mcq when option labels were found, short_answer when none were.
   *
   * A DETECTION, and named so. The bank's own qtype wins wherever the question
   * already exists; this is only load-bearing for a question being created.
   */
  detectedType: QuestionType | null
  /**
   * Marks printed on the block, where the format carries them. Usually null.
   *
   * ┌─────────────────────────────────────────────────────────────────────────┐
   * │ DETECTED AND REPORTED, NEVER STORED.                                    │
   * │                                                                         │
   * │ Every question in this product is worth exactly one mark.               │
   * │ src/lib/papers/blueprint.ts derives an entire paper from its mark total │
   * │ on that basis, and there is deliberately no per-question marks column   │
   * │ anywhere in the bank. A document printing anything else is surfaced as  │
   * │ a warning — neither silently dropped nor silently obeyed.               │
   * └─────────────────────────────────────────────────────────────────────────┘
   */
  marks: number | null
  /** 0-based position in the document. The identity when externalId is absent. */
  index: number
  issues: ParseIssue[]
}

/** One answer-key entry. */
export interface ParsedKeyEntry {
  externalId: string | null
  number: number | null
  /** MCQ only. The POSITION of the correct option — never its text. */
  letter: OptionKey | null
  /** Short answer only: the model answer. */
  answerText: string | null
  explanation: string | null
  index: number
  issues: ParseIssue[]
}

/**
 * A parsed document.
 *
 * `fatal` means nothing was understood — an empty file, a mis-encoded file, a
 * format nothing here recognises. It is separate from `issues` because there is
 * no partial result to show and nothing for a person to choose between.
 */
export interface ParsedPaper {
  format: PaperFormat
  questions: ParsedQuestion[]
  sections: string[]
  headings: string[]
  fatal?: string
}

export interface ParsedAnswerKey {
  format: PaperFormat
  entries: ParsedKeyEntry[]
  headings: string[]
  fatal?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// What the bank already knows
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One question as it exists in the bank today, for the ids a file named.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE BANK IS THE AUTHORITY FOR EVERY FIELD HERE, AND THE FILE IS NOT.      ║
 * ║                                                                           ║
 * ║ A translated paper carries a translated topic heading, a translated       ║
 * ║ section name and no difficulty at all. Reading a question's topic out of  ║
 * ║ "दोष और समाधान" would mean matching a translated string against an        ║
 * ║ English slug list — and topicSlug() strips every non-[a-z0-9] character,  ║
 * ║ so every Devanagari heading slugifies to the EMPTY STRING. Two different  ║
 * ║ topics would collide on "" and the import would silently retopic a        ║
 * ║ thousand questions.                                                       ║
 * ║                                                                           ║
 * ║ So for a question that already exists, difficulty, qtype, status, topic   ║
 * ║ and correctOption all come from this record. The file supplies TEXT.      ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */
export interface BankFact {
  externalId: string
  qtype: QuestionType
  difficulty: Difficulty
  status: QuestionStatus
  correctOption: OptionKey | null
  topicSlug: string | null
  /** Languages already stored. Drives "adds hi" vs "replaces hi". */
  locales: BankLocale[]
}

// ─────────────────────────────────────────────────────────────────────────────
// The verdict
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Why a question cannot be imported, or why it deserves a second look.
 *
 * Codes rather than only sentences, for the same reason REJECTION_REASONS
 * exists in import/format.ts: at a thousand questions the CATEGORY is what
 * drives a fix, and a list of a thousand sentences is a log.
 */
export const FINDING_CODES = [
  // ── Blocking ──────────────────────────────────────────────────────────────
  'unknown-question',
  'cannot-create-without-english',
  'missing-stem',
  'stem-too-short',
  'stem-too-long',
  'missing-options',
  'blank-option',
  'option-too-long',
  'missing-answer-key',
  'answer-not-an-option',
  'answer-disagrees-with-bank',
  'unexpected-answer-letter',
  'missing-model-answer',
  'model-answer-too-long',
  'explanation-too-long',
  'duplicate-external-id',
  'duplicate-question-text',
  'duplicate-question-number',
  'missing-external-id',
  'unknown-topic',
  'missing-difficulty',
  'type-disagrees-with-bank',
  // ── Advisory ──────────────────────────────────────────────────────────────
  'extra-answer-key-entry',
  'missing-question-number',
  'question-number-gap',
  'residual-english',
  'replaces-existing-translation',
  'unknown-heading',
  'marks-not-stored',
] as const
export type FindingCode = (typeof FINDING_CODES)[number]

export interface Finding {
  code: FindingCode
  /** Human-readable, and complete on its own. Never a database code. */
  message: string
  /** Which editable field it is about, so the preview can point at it. */
  field?: PreparedField
  /** The raw cause, shown only behind "Technical details". */
  technical?: string
}

export const PREPARED_FIELDS = [
  'stem',
  'optionA',
  'optionB',
  'optionC',
  'optionD',
  'correctOption',
  'answerText',
  'explanation',
  'topicSlug',
  'difficulty',
  'qtype',
  'externalId',
] as const
export type PreparedField = (typeof PREPARED_FIELDS)[number]

/** What this question will do if the import runs. */
export const IMPORT_ACTIONS = ['update', 'create', 'skip'] as const
export type ImportAction = (typeof IMPORT_ACTIONS)[number]

/** How to treat a question the bank already holds. */
export const DUPLICATE_MODES = ['update', 'skip'] as const
export type DuplicateMode = (typeof DUPLICATE_MODES)[number]

/**
 * One question, merged from the paper, the key and the bank, and ready to be
 * looked at, edited, and — if nothing blocks — written.
 *
 * This is what the preview renders and what the edit overrides apply to. It is
 * deliberately FLAT: an editor binding to `options.A` through an optional
 * nested object is where undefined-vs-empty-string bugs live.
 */
export interface PreparedQuestion {
  /** Stable across re-validation, so React keys and edits survive an edit. */
  key: string
  externalId: string
  number: number | null
  heading: string | null

  stem: string
  optionA: string | null
  optionB: string | null
  optionC: string | null
  optionD: string | null
  correctOption: OptionKey | null
  answerText: string | null
  explanation: string | null
  /** What the document printed. Shown, never written — see ParsedQuestion. */
  marks: number | null

  qtype: QuestionType
  difficulty: Difficulty
  topicSlug: string | null

  action: ImportAction
  /** True when the bank already holds this id. Drives new-vs-existing counts. */
  existing: boolean
  /** True when the bank already holds THIS LOCALE for this question. */
  replacesTranslation: boolean

  errors: Finding[]
  warnings: Finding[]
  /** True when the person changed something in the preview. */
  edited: boolean
}

/** Overrides a person typed in the preview, keyed by PreparedQuestion.key. */
export type QuestionEdits = Record<string, Partial<Record<PreparedField, string>>>

/**
 * The whole dry run, in the categories the screen is read in.
 *
 * Every number here is a COUNT OF THE FULL SET, never of a sampled page. The
 * preview paginates; the report does not.
 */
export interface PaperReport {
  /** Set when nothing could be read. No partial result exists to show. */
  fatal?: string

  locale: BankLocale
  format: PaperFormat | null

  questions: PreparedQuestion[]

  // ── Coverage ─────────────────────────────────────────────────────────────
  detected: number
  keyEntries: number
  matched: number

  // ── What would happen ────────────────────────────────────────────────────
  newCount: number
  existingCount: number
  updateCount: number
  createCount: number
  skipCount: number
  /** Rows the importer refuses to write. Always the same as errorCount. */
  rejectedCount: number

  // ── Health ───────────────────────────────────────────────────────────────
  validCount: number
  warningCount: number
  errorCount: number
  /** Errors that hold the Import button down. */
  blockingCount: number

  // ── Detail worth surfacing above the list ────────────────────────────────
  /** Key entries naming a question the paper does not contain. */
  extraKeyIds: string[]
  /**
   * Problems with the answer key's own STRUCTURE rather than with any one
   * question — a grid whose cells do not divide into rows, most importantly.
   *
   * Kept separate because such a fault cannot be attributed to a question and
   * would therefore have nowhere to appear. A shifted grid is exactly the
   * failure that is invisible per-question: every row still looks well-formed,
   * and each one is about the wrong question.
   */
  keyProblems: string[]
  duplicateIds: string[]
  duplicateNumbers: number[]
  missingNumbers: number[]
  /** Topic headings seen in the document that match no known topic. */
  unknownHeadings: string[]

  errorsByCode: Partial<Record<FindingCode, number>>
  warningsByCode: Partial<Record<FindingCode, number>>
  countsByType: Record<QuestionType, number>
  countsByDifficulty: Record<Difficulty, number>
}
