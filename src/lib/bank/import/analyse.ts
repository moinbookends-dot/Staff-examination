import {
  BANK_LOCALES,
  DIFFICULTIES,
  type BankLocale,
  type Difficulty,
  type QuestionType,
} from '../vocabulary'
import {
  classifySchemaIssue,
  dedupeKey,
  importEnvelopeSchema,
  importQuestionSchema,
  pruneNulls,
  REJECTION_REASONS,
  shapeIssues,
  topicSlug,
  type ImportQuestion,
  type RejectionReason,
} from './format'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The dry run.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ NOTHING IS WRITTEN UNTIL A PERSON HAS SEEN THIS REPORT.                    ║
 * ║                                                                           ║
 * ║ A 3,000-row import that half-succeeds is far worse than one that fails:    ║
 * ║ the bank ends in a state nobody can describe, and the only way back is     ║
 * ║ working out which rows landed. So parsing and validation are a pure        ║
 * ║ function producing a report, and the commit step takes the report's        ║
 * ║ `toImport` and `toUpdate` lists and nothing else.                          ║
 * ║                                                                           ║
 * ║ This module touches no database and no network. It is the whole reason     ║
 * ║ the importer is finished and tested before the tables exist.               ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface ImportRowError {
  /** 1-based, matching what a person sees in an editor. */
  row: number
  externalId?: string
  /** The dominant category, for grouping. Full detail is in `issues`. */
  reason: RejectionReason
  /** Every problem with this row, not just the first. */
  issues: string[]
}

export interface DuplicateRow {
  row: number
  firstSeenAtRow: number
  question: string
}

export interface MissingTranslationRow {
  row: number
  externalId?: string
  locales: BankLocale[]
  /** True when the row asked for `active` and had to be held back as a draft. */
  downgradedToDraft: boolean
}

export interface ImportReport {
  // ── What would happen ────────────────────────────────────────────────────
  /** New questions — no existing row carries this externalId. */
  toImport: ImportQuestion[]
  /** Existing questions that would be overwritten, matched on externalId. */
  toUpdate: ImportQuestion[]

  rejected: ImportRowError[]
  duplicates: DuplicateRow[]

  // ── Counts, in the categories the report is read by ──────────────────────
  totalRows: number
  importedCount: number
  updatedCount: number
  rejectedCount: number
  duplicateCount: number

  /** How many rejections fell into each cause. The number that drives a fix. */
  rejectionsByReason: Record<RejectionReason, number>

  // ── Advisories — reported, never a rejection ─────────────────────────────
  missingTranslations: MissingTranslationRow[]
  /** Rows that asked for `active` and will land as `draft`. */
  downgradedToDraftCount: number
  /** Topic names seen that are not in the known list. */
  unknownTopics: string[]

  countsByDifficulty: Record<Difficulty, number>
  countsByType: { mcq: number; short_answer: number }
  /**
   * Rejected rows split the same way, read from the raw row's `type` so a
   * schema-failing row still lands in the right column. A row whose type is
   * itself unreadable counts as `unknown`.
   */
  rejectedByType: { mcq: number; short_answer: number; unknown: number }
  countsByStatus: { draft: number; active: number; archived: number }
  localeCoverage: Record<BankLocale, number>
  topics: string[]

  /**
   * The brand slug the file's envelope names, verbatim. Only the canonical
   * envelope shape can carry one; a bare array or JSON Lines never sets it.
   * The UI compares it against the brand selected for the import — analyse
   * itself has no idea which brands exist.
   */
  declaredBrand?: string

  /** Set when the file itself could not be read at all. */
  fatal?: string
}

export interface AnalyseOptions {
  /**
   * Topic slugs that exist. An unrecognised topic is REJECTED rather than
   * created: at 3,000 rows a typo would otherwise quietly produce "Food Safty"
   * as a fifteenth topic, and nobody would notice until they filtered by it.
   *
   * Empty disables the check, so the parser is usable before topics are loaded.
   */
  knownTopics?: readonly string[]

  /**
   * externalIds already in the bank. Lets the dry run say "1,200 new, 1,800
   * updated" BEFORE writing, which is the difference between a confident
   * re-import and a hopeful one.
   *
   * Empty means everything reads as new — correct for a first import.
   */
  existingExternalIds?: readonly string[]

  /**
   * Languages a question must have to be `active`, mirroring
   * exam_settings.required_locales. A row claiming active without them is
   * downgraded to draft rather than rejected.
   */
  requiredLocales?: readonly BankLocale[]

  /**
   * The questions already in THIS BRAND's bank, by level and English text.
   *
   * ┌─────────────────────────────────────────────────────────────────────┐
   * │ WITHOUT THIS, A TRANSLATION CANNOT FIND ITS QUESTION.               │
   * │                                                                     │
   * │ externalId was the only thing that made a row read as an update,    │
   * │ so a bank imported without ids could never be added to: every row   │
   * │ of a re-import counted as new, and the commit then collided with    │
   * │ the English-text unique index and rolled the batch back.            │
   * │                                                                     │
   * │ Keyed by questionKey() — the index's own expression — and carrying  │
   * │ the stored qtype, because a match that disagrees about the type is  │
   * │ the one case an update cannot resolve.                              │
   * │                                                                     │
   * │ Empty means everything reads as new, which is correct for a first   │
   * │ import and is what every caller did before this existed.            │
   * └─────────────────────────────────────────────────────────────────────┘
   */
  existingQuestions?: readonly { key: string; qtype: QuestionType }[]
}

function emptyReport(): ImportReport {
  return {
    toImport: [],
    toUpdate: [],
    rejected: [],
    duplicates: [],
    totalRows: 0,
    importedCount: 0,
    updatedCount: 0,
    rejectedCount: 0,
    duplicateCount: 0,
    rejectionsByReason: Object.fromEntries(REJECTION_REASONS.map((r) => [r, 0])) as Record<
      RejectionReason,
      number
    >,
    missingTranslations: [],
    downgradedToDraftCount: 0,
    unknownTopics: [],
    countsByDifficulty: { easy: 0, medium: 0, hard: 0 },
    countsByType: { mcq: 0, short_answer: 0 },
    rejectedByType: { mcq: 0, short_answer: 0, unknown: 0 },
    countsByStatus: { draft: 0, active: 0, archived: 0 },
    localeCoverage: { en: 0, hi: 0, gu: 0 },
    topics: [],
  }
}

/**
 * Pull an array of rows out of whatever shape the file arrived in.
 *
 * Three are accepted so a generation process does not have to reformat: the
 * canonical envelope, a bare array, and JSON Lines. Anything else is a fatal
 * error naming what was expected — "Unexpected token" from JSON.parse tells
 * somebody holding a 3,000-row file nothing useful.
 */
export function extractRows(
  raw: string,
): { rows: unknown[]; brand?: string } | { fatal: string } {
  const text = raw.trim()
  if (!text) return { fatal: 'The file is empty.' }

  try {
    const parsed: unknown = JSON.parse(text)

    if (Array.isArray(parsed)) return { rows: parsed }

    const envelope = importEnvelopeSchema.safeParse(parsed)
    if (envelope.success) return { rows: envelope.data.questions, brand: envelope.data.brand }

    return {
      fatal:
        'The file is valid JSON but is not a question list. Expected either an array of questions, or an object with a "questions" array.',
    }
  } catch {
    // Fall through to JSON Lines. Detected only after the whole-file parse
    // fails, because a pretty-printed object also spans many lines.
  }

  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== '')
  const rows: unknown[] = []
  for (const [i, line] of lines.entries()) {
    try {
      rows.push(JSON.parse(line))
    } catch {
      return {
        fatal: `The file is not valid JSON, and line ${i + 1} is not a JSON object either. Expected a JSON array, an object with a "questions" array, or one JSON object per line.`,
      }
    }
  }
  return { rows }
}

export function analyseImport(raw: string, options: AnalyseOptions = {}): ImportReport {
  const known = new Set((options.knownTopics ?? []).map(topicSlug))
  const existing = new Set(options.existingExternalIds ?? [])
  const inBank = new Map(
    (options.existingQuestions ?? []).map((q) => [q.key, q.qtype] as const),
  )
  const required = options.requiredLocales ?? ['en']

  const report = emptyReport()

  const extracted = extractRows(raw)
  if ('fatal' in extracted) {
    report.fatal = extracted.fatal
    return report
  }
  report.declaredBrand = extracted.brand

  const seen = new Map<string, number>()
  /*
   * ┌───────────────────────────────────────────────────────────────────────────┐
   * │ A SECOND IDENTITY, BECAUSE THE DATABASE HAS TWO UNIQUE INDEXES.           │
   * │                                                                           │
   * │ `seen` mirrors bank_question_texts_dedupe_uq — (brand, difficulty,        │
   * │ lower(english)). It does NOT catch two DIFFERENT questions that share an  │
   * │ externalId, because their text differs.                                   │
   * │                                                                           │
   * │ 0058 added bank_questions_external_id_uq, and bank_import_commit() walks  │
   * │ rows in order: the first insert creates the question, the second finds it │
   * │ by externalId and UPDATES it. Two rows silently become one, and this      │
   * │ report — which promises that what it says is what gets written — said     │
   * │ two. The second question is discarded with no rejection and no duplicate  │
   * │ entry.                                                                    │
   * │                                                                           │
   * │ Found in the stabilization audit by importing a file whose report         │
   * │ promised 2 questions and whose commit stored 1.                           │
   * └───────────────────────────────────────────────────────────────────────────┘
   */
  const seenExternalIds = new Map<string, number>()
  const topics = new Set<string>()
  const unknownTopics = new Set<string>()

  report.totalRows = extracted.rows.length

  extracted.rows.forEach((originalRow, index) => {
    const row = index + 1
    // `"answer": null` means "no answer" — see pruneNulls. Required fields set
    // to null still fail below, now as "missing" rather than a type error.
    const rawRow = pruneNulls(originalRow)
    const parsed = importQuestionSchema.safeParse(rawRow)

    if (!parsed.success) {
      // The dominant reason is the first issue's category. Rows usually fail
      // for one cause; where they fail for several, the full list is kept.
      const reason = classifySchemaIssue(parsed.error.issues[0]?.path ?? [])
      report.rejected.push({
        row,
        externalId: readExternalId(rawRow),
        reason,
        issues: parsed.error.issues.map((issue) =>
          issue.path.length ? `${issue.path.join('.')}: ${issue.message}` : issue.message,
        ),
      })
      report.rejectionsByReason[reason] += 1
      report.rejectedByType[readQuestionType(rawRow)] += 1
      return
    }

    const question = parsed.data
    const issues = shapeIssues(question)

    if (question.topic) {
      const slug = topicSlug(question.topic)
      topics.add(slug)
      if (known.size > 0 && !known.has(slug)) {
        unknownTopics.add(question.topic)
        issues.push({
          reason: 'unknown-topic',
          message: `Unknown topic "${question.topic}". Add it in Settings first, or correct the spelling.`,
        })
      }
    }

    if (issues.length > 0) {
      const reason = issues[0].reason
      report.rejected.push({
        row,
        externalId: question.externalId,
        reason,
        issues: issues.map((i) => i.message),
      })
      report.rejectionsByReason[reason] += 1
      report.rejectedByType[question.type] += 1
      return
    }

    // Duplicate against an earlier row in this same file. The database would
    // refuse it too, but one row at a time and after the import began.
    const key = dedupeKey(question)
    const firstSeenAtRow = seen.get(key)
    if (firstSeenAtRow !== undefined) {
      report.duplicates.push({ row, firstSeenAtRow, question: question.en.question })
      return
    }

    /*
     * The same externalId twice in one file. Reported as a DUPLICATE rather
     * than a rejection, matching how a repeated question text is treated: the
     * first occurrence is kept and the later one is skipped, which is what the
     * person reading the report already expects "duplicate" to mean.
     *
     * Skipping is also what makes the report honest — bank_import_commit()
     * would otherwise let the second row overwrite the first, and the file
     * would silently lose a question.
     */
    if (question.externalId) {
      const firstIdRow = seenExternalIds.get(question.externalId)
      if (firstIdRow !== undefined) {
        report.duplicates.push({
          row,
          firstSeenAtRow: firstIdRow,
          question: question.en.question,
        })
        return
      }
      seenExternalIds.set(question.externalId, row)
    }

    seen.set(key, row)

    /*
     * Missing translations are an advisory, never a rejection — but a row that
     * asked to be ACTIVE without a required language cannot be written that
     * way: the trigger in 0054 refuses it. Downgrading to draft keeps the
     * question and reports the fact, which is better than losing a perfectly
     * good row over a translation that is coming later anyway.
     */
    const missing = BANK_LOCALES.filter((l) => required.includes(l) && !question[l])
    const optionalMissing = BANK_LOCALES.filter((l) => !question[l])

    let effective = question
    if (missing.length > 0 && question.status === 'active') {
      effective = { ...question, status: 'draft' }
      report.downgradedToDraftCount += 1
    }

    if (optionalMissing.length > 0) {
      report.missingTranslations.push({
        row,
        externalId: question.externalId,
        locales: optionalMissing,
        downgradedToDraft: effective.status !== question.status,
      })
    }

    /*
     * New, or an addition to a question already here?
     *
     * By id first — exact, and what a generated corpus supplies. Then by the
     * English text at this level, which is how a translation file finds the
     * question it belongs to: the same 1,000 questions arriving with a Hindi
     * block are the same 1,000 questions, not 1,000 new ones.
     *
     * Both are checked against THIS brand only. The two banks are separate,
     * and the same English sentence may legitimately exist in each.
     */
    const byId = Boolean(effective.externalId && existing.has(effective.externalId))
    const storedType = inBank.get(dedupeKey(effective))

    /*
     * The one match an update cannot resolve. Changing a question's type
     * rewrites its answer shape — four options become a model answer — and
     * the database refuses the half-changed state that would pass through.
     * Refused by name here so the row is named in the report rather than
     * arriving as a constraint violation mid-commit.
     */
    if (!byId && storedType !== undefined && storedType !== effective.type) {
      report.rejected.push({
        row,
        externalId: effective.externalId,
        reason: 'type-conflict',
        issues: [
          `This question is already in the bank at this level as a ${storedType === 'mcq' ? 'multiple choice' : 'short answer'} question, and this file calls it ${effective.type === 'mcq' ? 'multiple choice' : 'short answer'}. Change it in the editor, or correct the file.`,
        ],
      })
      report.rejectionsByReason['type-conflict'] += 1
      report.rejectedByType[effective.type] += 1
      return
    }

    const isUpdate = byId || storedType !== undefined
    if (isUpdate) report.toUpdate.push(effective)
    else report.toImport.push(effective)

    report.countsByDifficulty[effective.difficulty] += 1
    report.countsByType[effective.type] += 1
    report.countsByStatus[effective.status] += 1
    for (const locale of BANK_LOCALES) {
      if (effective[locale]) report.localeCoverage[locale] += 1
    }
  })

  report.importedCount = report.toImport.length
  report.updatedCount = report.toUpdate.length
  report.rejectedCount = report.rejected.length
  report.duplicateCount = report.duplicates.length
  report.topics = [...topics].sort()
  report.unknownTopics = [...unknownTopics].sort()

  return report
}

/** Best-effort id for an unparseable row, so the error can still name it. */
function readQuestionType(row: unknown): 'mcq' | 'short_answer' | 'unknown' {
  if (row && typeof row === 'object' && 'type' in row) {
    const value = (row as { type: unknown }).type
    if (value === 'mcq' || value === 'short_answer') return value
  }
  return 'unknown'
}

function readExternalId(row: unknown): string | undefined {
  if (row && typeof row === 'object' && 'externalId' in row) {
    const value = (row as { externalId: unknown }).externalId
    if (typeof value === 'string') return value
  }
  return undefined
}

/**
 * Is this report worth importing?
 *
 * Deliberately permissive: a file with some bad rows can still be imported for
 * its good ones, because at 3,000 rows demanding perfection means nothing ever
 * loads. The UI shows the categories and the person decides.
 *
 * A fatal error is different — nothing was understood, so there is nothing to
 * choose between.
 */
export function isImportable(report: ImportReport): boolean {
  return !report.fatal && report.importedCount + report.updatedCount > 0
}

/**
 * How the bank would look after this import, per level.
 *
 * The target is 1,000 per level. A 3,000-row file that turns out to be 1,400
 * Easy and 600 Hard is worth seeing BEFORE it lands, rather than discovering it
 * when a Hard paper cannot be generated.
 */
export function difficultyBalance(report: ImportReport): {
  difficulty: Difficulty
  count: number
  share: number
}[] {
  const total = report.importedCount + report.updatedCount || 1
  return DIFFICULTIES.map((difficulty) => ({
    difficulty,
    count: report.countsByDifficulty[difficulty],
    share: report.countsByDifficulty[difficulty] / total,
  }))
}
