import { topicSlug } from '../import/format'
import {
  ANSWER_MAX_LENGTH,
  DIFFICULTIES,
  OPTION_KEYS,
  QUESTION_MAX_LENGTH,
  QUESTION_MIN_LENGTH,
  QUESTION_TYPES,
  type BankLocale,
  type Difficulty,
  type OptionKey,
  type QuestionType,
} from '../vocabulary'
import { latinWords } from './decode'
import type {
  BankFact,
  DuplicateMode,
  Finding,
  FindingCode,
  ImportAction,
  PaperReport,
  ParsedAnswerKey,
  ParsedKeyEntry,
  ParsedPaper,
  PreparedQuestion,
  QuestionEdits,
} from './types'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The dry run for a question paper.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ DETERMINISTIC. THERE IS NO "LOOKS GOOD" ANYWHERE IN THIS FILE.            ║
 * ║                                                                           ║
 * ║ Every verdict is a comparison against something knowable: a length in a   ║
 * ║ CHECK constraint, a letter in the bank, an id in a set. Nothing is scored,║
 * ║ nothing is thresholded, and nothing is inferred from how a question reads.║
 * ║                                                                           ║
 * ║ Two consequences that are the whole point:                                ║
 * ║                                                                           ║
 * ║  · the same file always produces the same report, so a person can fix     ║
 * ║    one thing and see exactly one number change;                           ║
 * ║  · anything the parser was unsure about arrives here as an ISSUE and      ║
 * ║    leaves as a visible finding, rather than being resolved by a default.  ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE CHECK THAT MATTERS MOST IS THE ANSWER LETTER.                         │
 * │                                                                           │
 * │ For a question already in the bank, the key's letter must EQUAL the       │
 * │ bank's correct_option. Checking only that the named option exists is not  │
 * │ enough and has already failed once: the first translation export agreed   │
 * │ with English on 267 of 1,000 answers, which is chance, and importing it   │
 * │ by position would have marked roughly three quarters of the bank against  │
 * │ another question's answer.                                                │
 * │                                                                           │
 * │ That failure is invisible on every screen in this product. It surfaces    │
 * │ months later as a member of staff saying "I answered correctly and was    │
 * │ marked wrong", by which time the paper is closed and the marks are        │
 * │ released. So it is a blocking error, never a warning.                     │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface ValidateOptions {
  /** The language this file is in. */
  locale: BankLocale
  /**
   * The bank's own record for every id the file named, from
   * resolvePaperTargets(). Undefined means the lookup has not run yet — the
   * report is then structural only and NOTHING is importable, because "new or
   * existing" is unanswerable and every answer-letter check needs it.
   */
  facts?: readonly BankFact[]
  /** What to do with a question the bank already holds. */
  duplicateMode: DuplicateMode
  /** Create questions the bank does not hold. Only ever possible in English. */
  createUnmatched: boolean
  /** Level for created questions. Ignored for questions that already exist. */
  createDifficulty: Difficulty | null
  /** Topic heading → topic slug, as chosen in the topic mapper. */
  headingTopics?: Readonly<Record<string, string>>
  /** Topic slugs that exist. Empty disables the check. */
  knownTopics?: readonly string[]
  /** What the person changed in the preview, keyed by PreparedQuestion.key. */
  edits?: QuestionEdits
}

/** The longest an option may be, mirroring importTextSchema in import/format.ts. */
const OPTION_MAX_LENGTH = 500
const EXPLANATION_MAX_LENGTH = 2000
const EXTERNAL_ID_MAX_LENGTH = 100

export function analysePaper(
  paper: ParsedPaper,
  key: ParsedAnswerKey | null,
  options: ValidateOptions,
): PaperReport {
  const report = emptyReport(options.locale, paper.fatal ? null : paper.format)

  if (paper.fatal) return { ...report, fatal: paper.fatal }
  if (key?.fatal) return { ...report, fatal: key.fatal }

  const facts = new Map((options.facts ?? []).map((fact) => [fact.externalId, fact]))
  const resolved = options.facts !== undefined
  const known = new Set((options.knownTopics ?? []).map(topicSlug))
  const edits = options.edits ?? {}
  const headingTopics = options.headingTopics ?? {}

  // ── The key, indexed ───────────────────────────────────────────────────────
  const keyById = new Map<string, ParsedKeyEntry>()
  const keyDuplicates = new Set<string>()
  for (const entry of key?.entries ?? []) {
    if (!entry.externalId) {
      // An entry with no id belongs to no question, so its problems have
      // nowhere else to be reported. A malformed grid arrives here.
      for (const issue of entry.issues) report.keyProblems.push(issue.message)
      continue
    }
    if (keyById.has(entry.externalId)) keyDuplicates.add(entry.externalId)
    else keyById.set(entry.externalId, entry)
  }

  // ── Identity across the whole file, before any per-question verdict ───────
  const idCounts = countBy(paper.questions.map((q) => q.externalId))
  const numberCounts = countBy(paper.questions.map((q) => q.number))

  report.duplicateIds = [...idCounts.entries()]
    .filter(([id, n]) => id !== null && n > 1)
    .map(([id]) => String(id))
    .sort()

  report.duplicateNumbers = [...numberCounts.entries()]
    .filter(([number, n]) => number !== null && n > 1)
    .map(([number]) => Number(number))
    .sort((a, b) => a - b)

  report.missingNumbers = gaps(paper.questions.map((q) => q.number))

  // ── Every question ─────────────────────────────────────────────────────────
  const seenIds = new Set<string>()

  /**
   * English stems already claimed by an earlier row in THIS file.
   *
   * Mirrors the partial unique index in 0054 — (brand_id, difficulty,
   * lower(btrim(question))) where locale = 'en' — which is evaluated after
   * every statement inside bank_import_commit's transaction and therefore sees
   * the halfway point of a batch. Two rows in one file claiming the same
   * English sentence abort the whole import at whichever row comes second.
   *
   * Only populated for an English import: the index is scoped to locale 'en',
   * so a Hindi file re-sending each question's unchanged English text cannot
   * collide with anything, including itself.
   */
  const seenStems = new Map<string, string>()

  for (const parsed of paper.questions) {
    const rowKey = `row-${parsed.index}`
    const edit = edits[rowKey] ?? {}
    const errors: Finding[] = []
    const warnings: Finding[] = []

    const externalId = (edit.externalId ?? parsed.externalId ?? '').trim()
    const fact = externalId ? facts.get(externalId) : undefined
    const existing = Boolean(fact)

    // ── Identity ─────────────────────────────────────────────────────────────
    if (!externalId) {
      errors.push({
        code: 'missing-external-id',
        field: 'externalId',
        message:
          'This question carries no id, so it cannot be matched to the bank and a re-import would duplicate it. Give it the id the bank uses.',
      })
    } else if (externalId.length > EXTERNAL_ID_MAX_LENGTH) {
      errors.push({
        code: 'missing-external-id',
        field: 'externalId',
        message: `The id is ${externalId.length} characters; the longest the bank stores is ${EXTERNAL_ID_MAX_LENGTH}.`,
      })
    } else if (seenIds.has(externalId)) {
      errors.push({
        code: 'duplicate-external-id',
        field: 'externalId',
        message: `The id "${externalId}" appears more than once in this file. Two questions cannot share one id — the second would overwrite the first and the import would silently lose a question.`,
      })
    }
    if (externalId) seenIds.add(externalId)

    if (parsed.number !== null && (numberCounts.get(parsed.number) ?? 0) > 1) {
      errors.push({
        code: 'duplicate-question-number',
        message: `Question number ${parsed.number} appears more than once in this file.`,
      })
    }
    if (parsed.number === null) {
      warnings.push({
        code: 'missing-question-number',
        message: 'This question has no printed number, so it cannot be referred to by one.',
      })
    }

    // ── Does the bank hold it? ───────────────────────────────────────────────
    if (resolved && externalId && !existing) {
      if (options.locale === 'en' && options.createUnmatched) {
        // Creatable. Everything a new question needs is checked below.
      } else if (options.locale === 'en') {
        errors.push({
          code: 'unknown-question',
          field: 'externalId',
          message: `"${externalId}" is not in the bank for this brand. Turn on "Create questions the bank does not have" to add it, or correct the id.`,
        })
      } else {
        /*
         * The honest refusal, and the one this whole feature is shaped around.
         * A question must have English to exist at all — importQuestionSchema
         * requires it, and bank_question_texts_completeness enforces it — so a
         * Hindi-only document has nothing to create a question FROM. Saying so
         * per id beats importing 1,029 and silently dropping one.
         */
        errors.push({
          code: 'cannot-create-without-english',
          field: 'externalId',
          message: `"${externalId}" is not in the bank for this brand. A ${localeName(options.locale)} file can only add a translation to a question that already exists — it has no English text to create one from. Import the English question first.`,
        })
      }
    }

    /*
     * ┌───────────────────────────────────────────────────────────────────────┐
     * │ ONLY THE PARSER ISSUES THE VALIDATOR CANNOT RE-DERIVE.                │
     * │                                                                       │
     * │ Every other issue — no stem, a blank option, a partial option set, an │
     * │ unreadable block — is visible in the MERGED values checked below, and │
     * │ carrying it through as well reported the same problem twice on one    │
     * │ question. That is not cosmetic: `errorsByCode` is the number somebody │
     * │ uses to decide what to fix first, and doubling it makes the biggest   │
     * │ category the one with the most redundant reporting rather than the    │
     * │ most broken questions.                                                │
     * │                                                                       │
     * │ A repeated option label survives, because after merging there is only │
     * │ one A and the fact that the document contained two is unrecoverable.  │
     * └───────────────────────────────────────────────────────────────────────┘
     */
    for (const issue of parsed.issues) {
      if (issue.code !== 'repeated-option-label') continue
      errors.push({
        code: 'blank-option',
        message: issue.message,
        technical: `parser: ${issue.code}`,
      })
    }

    // ── Type, level and topic: the bank wins wherever it has an opinion ──────
    const qtype = readEnum(edit.qtype, QUESTION_TYPES) ?? fact?.qtype ?? parsed.detectedType ?? 'mcq'
    const difficulty =
      readEnum(edit.difficulty, DIFFICULTIES) ?? fact?.difficulty ?? options.createDifficulty ?? 'medium'

    if (existing && parsed.detectedType && parsed.detectedType !== fact?.qtype) {
      errors.push({
        code: 'type-disagrees-with-bank',
        field: 'qtype',
        message: `The bank holds "${externalId}" as ${typeName(fact!.qtype)}, but this file presents it as ${typeName(parsed.detectedType)}. One of the two is about the wrong question.`,
      })
    }

    /*
     * ┌───────────────────────────────────────────────────────────────────────┐
     * │ THE CREATE-PATH CHECKS ONLY RUN ONCE THE BANK HAS ANSWERED.           │
     * │                                                                       │
     * │ Before the lookup returns, `existing` is false for every question —   │
     * │ not because the bank does not have them, but because nobody has asked │
     * │ yet. Running the create-path rules against that state reported "no    │
     * │ topic has been chosen" against all 1,030 questions of a document      │
     * │ whose questions all already exist and all already have topics.        │
     * │                                                                       │
     * │ Caught by driving the real screen: the browser showed 1,030 blocking  │
     * │ errors for a second and a half before the lookup came back. Nobody    │
     * │ watching a spinner would have seen it; a person on a slow connection  │
     * │ would have read the whole scary report and stopped.                   │
     * │                                                                       │
     * │ "I do not know yet" is not "it is new". Unresolved means the report   │
     * │ is STRUCTURAL only, which is also why nothing is importable until the │
     * │ lookup lands.                                                         │
     * └───────────────────────────────────────────────────────────────────────┘
     */
    let slug: string | null = null
    if (existing) {
      slug = fact?.topicSlug ?? null
    } else if (resolved) {
      const chosen = edit.topicSlug ?? (parsed.heading ? headingTopics[parsed.heading] : undefined)
      slug = chosen ? topicSlug(chosen) : null

      if (parsed.heading && !chosen) {
        // Never guessed at. A Devanagari heading slugifies to the empty string,
        // so "matching" it against the topic list would collide every heading
        // onto one topic — see the box on BankFact.
        errors.push({
          code: 'unknown-topic',
          field: 'topicSlug',
          message: `No topic has been chosen for the heading "${parsed.heading}". Map it to an existing topic before importing.`,
        })
      } else if (slug && known.size > 0 && !known.has(slug)) {
        errors.push({
          code: 'unknown-topic',
          field: 'topicSlug',
          message: `There is no topic "${slug}". Choose one that exists, or add it in Topic Management first.`,
        })
      }
      if (!options.createDifficulty && !edit.difficulty) {
        errors.push({
          code: 'missing-difficulty',
          field: 'difficulty',
          message: 'A new question needs a level. Choose one for this import.',
        })
      }
    }

    // ── The text ─────────────────────────────────────────────────────────────
    const stem = (edit.stem ?? parsed.stem).trim()
    if (!stem) {
      errors.push({ code: 'missing-stem', field: 'stem', message: 'The question text is empty.' })
    } else if (stem.length < QUESTION_MIN_LENGTH) {
      errors.push({
        code: 'stem-too-short',
        field: 'stem',
        message: `The question text is ${stem.length} characters; the bank requires at least ${QUESTION_MIN_LENGTH}.`,
      })
    } else if (stem.length > QUESTION_MAX_LENGTH) {
      errors.push({
        code: 'stem-too-long',
        field: 'stem',
        message: `The question text is ${stem.length} characters; the bank stores at most ${QUESTION_MAX_LENGTH}.`,
      })
    }

    const optionText: Record<OptionKey, string | null> = {
      A: pick(edit.optionA, parsed.options.A),
      B: pick(edit.optionB, parsed.options.B),
      C: pick(edit.optionC, parsed.options.C),
      D: pick(edit.optionD, parsed.options.D),
    }
    const present = OPTION_KEYS.filter((letter) => optionText[letter])

    const entry = externalId ? keyById.get(externalId) : undefined
    let correctOption: OptionKey | null = readEnum(edit.correctOption, OPTION_KEYS) ?? entry?.letter ?? null
    let answerText = (edit.answerText ?? entry?.answerText ?? '').trim() || null
    const explanation = (edit.explanation ?? entry?.explanation ?? '').trim() || null

    if (key && externalId && !entry) {
      errors.push({
        code: 'missing-answer-key',
        message: `The answer key has no entry for "${externalId}", so there is no answer for this question.`,
      })
    }
    if (externalId && keyDuplicates.has(externalId)) {
      errors.push({
        code: 'missing-answer-key',
        message: `The answer key names "${externalId}" more than once. Only the first entry was read; remove the repeat so the right answer is not in doubt.`,
      })
    }

    /*
     * Whatever the parser could not make sense of in this question's key row,
     * verbatim. This is where "the key gives E, which is not one of A, B, C or
     * D" reaches the person — a detail that is gone by the time the letter has
     * been normalised to null.
     */
    for (const issue of entry?.issues ?? []) {
      errors.push({
        code: issue.code === 'no-answer-letter' ? 'answer-not-an-option' : 'missing-answer-key',
        field: 'correctOption',
        message: issue.message,
        technical: `parser: ${issue.code}`,
      })
    }
    const keyRowUnreadable = (entry?.issues.length ?? 0) > 0

    if (qtype === 'mcq') {
      answerText = null

      if (present.length !== OPTION_KEYS.length) {
        const missing = OPTION_KEYS.filter((letter) => !optionText[letter])
        errors.push({
          code: present.length === 0 ? 'missing-options' : 'blank-option',
          field: `option${missing[0] ?? 'A'}` as Finding['field'],
          message: `A multiple-choice question needs all four options. ${missing.join(', ')} ${
            missing.length === 1 ? 'is' : 'are'
          } missing or empty.`,
        })
      }

      for (const letter of OPTION_KEYS) {
        const text = optionText[letter]
        if (text && text.length > OPTION_MAX_LENGTH) {
          errors.push({
            code: 'option-too-long',
            field: `option${letter}` as Finding['field'],
            message: `Option ${letter} is ${text.length} characters; the bank stores at most ${OPTION_MAX_LENGTH}.`,
          })
        }
      }

      /*
       * Guarded so one missing answer is reported ONCE. "The key has no entry
       * for this question" and "this question has no correct answer" are the
       * same fact said twice, and the row above already said the first.
       */
      if (!correctOption) {
        if (!keyRowUnreadable && (entry || !key)) {
          errors.push({
            code: 'missing-answer-key',
            field: 'correctOption',
            message: key
              ? 'The answer key names this question but gives no correct option.'
              : 'No answer key has been analysed, so this question has no correct answer.',
          })
        }
      } else if (!optionText[correctOption]) {
        errors.push({
          code: 'answer-not-an-option',
          field: 'correctOption',
          message: `The answer key says "${correctOption}", but this question has no option ${correctOption}. Available options: ${
            present.length ? present.join(', ') : 'none'
          }.`,
        })
      } else if (existing && fact?.correctOption && correctOption !== fact.correctOption) {
        /*
         * See the box at the top. This is the one that reaches a person as a
         * wrong mark, and it is the reason a translated key is checked against
         * the bank rather than against itself.
         */
        errors.push({
          code: 'answer-disagrees-with-bank',
          field: 'correctOption',
          message: `The bank's answer for "${externalId}" is ${fact.correctOption}, but this answer key says ${correctOption}. One of the two is about a different question — importing either way would mark this question wrongly.`,
        })
      }
    } else {
      correctOption = null

      if (present.length > 0) {
        errors.push({
          code: 'missing-options',
          message: `A short-answer question must not have options, but ${present.join(', ')} ${
            present.length === 1 ? 'was' : 'were'
          } found.`,
        })
      }
      if (entry?.letter) {
        errors.push({
          code: 'unexpected-answer-letter',
          field: 'correctOption',
          message: `The answer key gives the letter ${entry.letter} for "${externalId}", but this is a short-answer question and has no options.`,
        })
      }
      // Guarded exactly as the MCQ branch above is, and for the same reason.
      if (!answerText && !keyRowUnreadable && (entry || !key)) {
        errors.push({
          code: 'missing-model-answer',
          field: 'answerText',
          message: key
            ? 'A short-answer question needs a model answer, and the key gives none.'
            : 'No answer key has been analysed, so this question has no model answer.',
        })
      }
      if (answerText && answerText.length > ANSWER_MAX_LENGTH) {
        errors.push({
          code: 'model-answer-too-long',
          field: 'answerText',
          message: `The model answer is ${answerText.length} characters; the bank stores at most ${ANSWER_MAX_LENGTH}.`,
        })
      }
    }

    if (options.locale === 'en' && stem) {
      const stemKey = `${difficulty}::${stem.toLowerCase()}`
      const owner = seenStems.get(stemKey)

      if (owner !== undefined && owner !== externalId) {
        errors.push({
          code: 'duplicate-question-text',
          field: 'stem',
          message: `This question has the same English text as "${owner}" at the same level. The bank refuses two questions that read identically, and importing both would abort the whole batch.`,
          technical: 'bank_question_texts_dedupe_uq (brand_id, difficulty, lower(btrim(question)))',
        })
      } else {
        seenStems.set(stemKey, externalId)
      }
    }

    if (explanation && explanation.length > EXPLANATION_MAX_LENGTH) {
      errors.push({
        code: 'explanation-too-long',
        field: 'explanation',
        message: `The explanation is ${explanation.length} characters; the bank stores at most ${EXPLANATION_MAX_LENGTH}.`,
      })
    }

    // ── Advisories ───────────────────────────────────────────────────────────
    if (options.locale !== 'en') {
      const stray = [stem, ...OPTION_KEYS.map((letter) => optionText[letter]), answerText]
        .flatMap((value) => latinWords(value))
        .filter((word, i, all) => all.indexOf(word) === i)

      if (stray.length > 0) {
        warnings.push({
          code: 'residual-english',
          message: `This ${localeName(options.locale)} question still contains English words: ${stray
            .slice(0, 6)
            .join(', ')}${stray.length > 6 ? '…' : ''}. Check it is fully translated.`,
        })
      }
    }

    if (fact?.locales.includes(options.locale)) {
      warnings.push({
        code: 'replaces-existing-translation',
        message: `The bank already holds ${localeName(options.locale)} for this question. Importing replaces it.`,
      })
    }

    if (parsed.marks !== null && parsed.marks !== 1) {
      warnings.push({
        code: 'marks-not-stored',
        message: `This question is printed as ${parsed.marks} marks. Every question in this product is worth one mark, and the figure is not stored — the paper's mark total is its question count.`,
      })
    }

    if (parsed.heading && existing) {
      // Recorded so the mapper can show what the document contained, but never
      // an error: the topic came from the bank and the heading is decoration.
      if (!report.unknownHeadings.includes(parsed.heading) && !headingTopics[parsed.heading]) {
        report.unknownHeadings.push(parsed.heading)
      }
    }

    // ── What will actually happen ────────────────────────────────────────────
    let action: ImportAction
    if (!resolved) action = 'skip'
    else if (existing) action = options.duplicateMode === 'skip' ? 'skip' : 'update'
    else if (options.locale === 'en' && options.createUnmatched && externalId) action = 'create'
    else action = 'skip'

    report.questions.push({
      key: rowKey,
      externalId,
      number: parsed.number,
      heading: parsed.heading,
      stem,
      optionA: qtype === 'mcq' ? optionText.A : null,
      optionB: qtype === 'mcq' ? optionText.B : null,
      optionC: qtype === 'mcq' ? optionText.C : null,
      optionD: qtype === 'mcq' ? optionText.D : null,
      correctOption,
      answerText,
      explanation,
      marks: parsed.marks,
      qtype,
      difficulty,
      topicSlug: slug,
      action,
      existing,
      replacesTranslation: Boolean(fact?.locales.includes(options.locale)),
      errors,
      warnings,
      edited: Object.keys(edit).length > 0,
    })
  }

  // ── Key entries the paper never mentioned ─────────────────────────────────
  const paperIds = new Set(report.questions.map((q) => q.externalId).filter(Boolean))
  report.extraKeyIds = [...keyById.keys()].filter((id) => !paperIds.has(id)).sort()

  return summarise(report, paper, key)
}

// ─────────────────────────────────────────────────────────────────────────────
// Counting
// ─────────────────────────────────────────────────────────────────────────────

function summarise(
  report: PaperReport,
  paper: ParsedPaper,
  key: ParsedAnswerKey | null,
): PaperReport {
  report.detected = paper.questions.length
  report.keyEntries = key?.entries.filter((entry) => entry.externalId).length ?? 0

  for (const question of report.questions) {
    if (question.existing) report.existingCount += 1
    else report.newCount += 1

    if (question.existing) report.matched += 1
    if (question.action === 'update') report.updateCount += 1
    if (question.action === 'create') report.createCount += 1
    if (question.action === 'skip') report.skipCount += 1

    if (question.errors.length > 0) {
      report.errorCount += 1
      /*
       * An error on a row the person DELIBERATELY chose to skip does not hold
       * the button down — they have already said that row is not being written.
       * An error on a row that was skipped because nothing could be done with
       * it does, because nobody asked for it to be dropped.
       */
      if (!(question.action === 'skip' && question.existing)) report.blockingCount += 1

      for (const finding of question.errors) {
        report.errorsByCode[finding.code] = (report.errorsByCode[finding.code] ?? 0) + 1
      }
    } else if (question.warnings.length > 0) {
      report.warningCount += 1
    } else {
      report.validCount += 1
    }

    for (const finding of question.warnings) {
      report.warningsByCode[finding.code] = (report.warningsByCode[finding.code] ?? 0) + 1
    }

    if (question.action !== 'skip') {
      report.countsByType[question.qtype] += 1
      report.countsByDifficulty[question.difficulty] += 1
    }
  }

  report.rejectedCount = report.errorCount

  if (report.extraKeyIds.length > 0) {
    report.warningsByCode['extra-answer-key-entry'] = report.extraKeyIds.length
  }

  return report
}

/**
 * Is this report worth importing?
 *
 * Both halves matter. A report with nothing to write is not importable however
 * clean it is, and a report with a blocking error is not importable however
 * much of it is fine — which is the opposite of how the JSON importer treats a
 * partly-bad file, deliberately: that one reads a curated dataset where bad
 * rows are a generator bug, and this one reads a document where a bad row
 * usually means the parse went wrong and the rest should not be trusted either.
 */
export function isPaperImportable(report: PaperReport): boolean {
  if (report.fatal) return false
  if (report.blockingCount > 0) return false
  return report.updateCount + report.createCount > 0
}

/** Questions that will actually be written, in document order. */
export function importableQuestions(report: PaperReport): PreparedQuestion[] {
  return report.questions.filter((question) => question.action !== 'skip')
}

// ─────────────────────────────────────────────────────────────────────────────
// Small shared helpers
// ─────────────────────────────────────────────────────────────────────────────

function emptyReport(locale: BankLocale, format: PaperReport['format']): PaperReport {
  return {
    locale,
    format,
    questions: [],
    detected: 0,
    keyEntries: 0,
    matched: 0,
    newCount: 0,
    existingCount: 0,
    updateCount: 0,
    createCount: 0,
    skipCount: 0,
    rejectedCount: 0,
    validCount: 0,
    warningCount: 0,
    errorCount: 0,
    blockingCount: 0,
    extraKeyIds: [],
    keyProblems: [],
    duplicateIds: [],
    duplicateNumbers: [],
    missingNumbers: [],
    unknownHeadings: [],
    errorsByCode: {} as Partial<Record<FindingCode, number>>,
    warningsByCode: {} as Partial<Record<FindingCode, number>>,
    countsByType: { mcq: 0, short_answer: 0 },
    countsByDifficulty: { easy: 0, medium: 0, hard: 0 },
  }
}

function countBy<T>(values: readonly T[]): Map<T, number> {
  const counts = new Map<T, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return counts
}

/**
 * Numbers the paper skipped.
 *
 * From the LOWEST number present to the highest, so a paper that starts at 101
 * does not report a hundred missing questions. Capped, because a single typo —
 * "Q10001." for "Q1001." — would otherwise produce nine thousand entries and a
 * report nobody can read.
 */
function gaps(numbers: readonly (number | null)[]): number[] {
  const present = numbers.filter((n): n is number => n !== null)
  if (present.length === 0) return []

  const seen = new Set(present)
  const lowest = Math.min(...present)
  const highest = Math.max(...present)
  const missing: number[] = []

  for (let n = lowest; n <= highest && missing.length <= 200; n += 1) {
    if (!seen.has(n)) missing.push(n)
  }
  return missing
}

function pick(edited: string | undefined, parsed: string | undefined): string | null {
  const value = (edited ?? parsed ?? '').trim()
  return value || null
}

/** A value from a closed vocabulary, or undefined when it is not one of them. */
function readEnum<T extends string>(
  value: string | undefined,
  allowed: readonly T[],
): T | undefined {
  return value !== undefined && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined
}

function localeName(locale: BankLocale): string {
  return locale === 'hi' ? 'Hindi' : locale === 'gu' ? 'Gujarati' : 'English'
}

function typeName(qtype: QuestionType): string {
  return qtype === 'mcq' ? 'multiple choice' : 'short answer'
}
