import { BANK_LOCALES } from '../vocabulary'
import { topicSlug, type ImportQuestion } from './format'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * From the contract's shape to the database's shape.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ A PURE FUNCTION, AND THAT IS WHAT MAKES THE IMPORT TESTABLE.              ║
 * ║                                                                           ║
 * ║ analyse.ts decides WHAT to write and touches no database. This decides    ║
 * ║ what that looks like as rows, and also touches no database. The only      ║
 * ║ thing left for the server action is one RPC call, so everything with a    ║
 * ║ decision in it can be tested without a connection.                        ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * The contract nests languages as named keys (`en`, `hi`, `gu`) because that is
 * what a generator naturally emits. The database stores one row per language in
 * bank_question_texts. This is that transposition, and it is the only place it
 * happens.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** One language, flattened to the column names bank_question_texts uses. */
export interface CommitText {
  locale: string
  question: string
  optionA: string | null
  optionB: string | null
  optionC: string | null
  optionD: string | null
  answerText: string | null
  explanation: string | null
}

/** One question, in the shape bank_import_commit() reads. */
export interface CommitRow {
  externalId: string | null
  difficulty: string
  qtype: string
  status: string
  /**
   * Already slugified, with the SAME function the dry run matched against the
   * known-topic list. If this used a different normalisation, a topic the
   * report accepted could fail to match at commit time and abort the import.
   */
  topicSlug: string | null
  correctOption: string | null
  referenceTitle: string | null
  referencePage: number | null
  texts: CommitText[]
}

/**
 * `type` in the contract, `qtype` in the database.
 *
 * The column is qtype because `type` is close enough to a reserved word to be a
 * nuisance in SQL; the contract says `type` because that is what reads
 * naturally in a hand-written JSON file. The rename lives here rather than in
 * either of them.
 */
export function toCommitRow(question: ImportQuestion): CommitRow {
  const texts: CommitText[] = []

  for (const locale of BANK_LOCALES) {
    const text = question[locale]
    if (!text) continue

    texts.push({
      locale,
      question: text.question,
      // An MCQ has options and no answer; a short answer the reverse. Both are
      // already guaranteed by shapeIssues() — spelling out null rather than
      // leaving keys absent so the SQL never has to distinguish "absent" from
      // "empty", which in JSON it cannot do reliably.
      optionA: text.options?.A ?? null,
      optionB: text.options?.B ?? null,
      optionC: text.options?.C ?? null,
      optionD: text.options?.D ?? null,
      answerText: text.answer ?? null,
      explanation: text.explanation ?? null,
    })
  }

  return {
    externalId: question.externalId ?? null,
    difficulty: question.difficulty,
    qtype: question.type,
    status: question.status,
    topicSlug: question.topic ? topicSlug(question.topic) : null,
    correctOption: question.correctOption ?? null,
    referenceTitle: question.reference?.document ?? null,
    referencePage: question.reference?.page ?? null,
    texts,
  }
}

/**
 * How many questions to send in one RPC call.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE WHOLE FILE IN ONE CALL WOULD DEFEAT THE ATOMICITY IT IS MEANT TO      │
 * │ PROVIDE — SO THE BATCHES ARE NOT A PERFORMANCE KNOB.                      │
 * │                                                                           │
 * │ 3,000 trilingual questions is roughly 9,000 text rows and several         │
 * │ megabytes of JSON. That is a single statement large enough to hit request │
 * │ limits and statement timeouts, and a timeout mid-import is exactly the    │
 * │ half-written state the transaction exists to prevent.                     │
 * │                                                                           │
 * │ Each batch is its own transaction, so a failure rolls back that batch     │
 * │ whole — never a fraction of a question. The importer reports how many     │
 * │ batches committed before the failure, which is a state a person can       │
 * │ describe and re-run: every row carries an externalId, so re-importing the │
 * │ same file UPDATES what already landed instead of duplicating it.          │
 * │                                                                           │
 * │ That is the honest trade. Full file atomicity is not available over a     │
 * │ stateless HTTP boundary, and pretending otherwise by sending one enormous │
 * │ request would make the failure mode worse, not better.                    │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export const IMPORT_BATCH_SIZE = 200

export function batchRows<T>(rows: readonly T[], size: number = IMPORT_BATCH_SIZE): T[][] {
  if (size < 1) throw new Error('Batch size must be at least 1.')

  const batches: T[][] = []
  for (let i = 0; i < rows.length; i += size) {
    batches.push(rows.slice(i, i + size))
  }
  return batches
}
