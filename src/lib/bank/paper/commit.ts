import type { Difficulty, OptionKey, QuestionType } from '../vocabulary'
import type { PaperReport, PreparedQuestion } from './types'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * From a reviewed question to the smallest thing that has to cross the wire.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE BROWSER SENDS ONE LANGUAGE. THE SERVER SENDS ALL OF THEM.             ║
 * ║                                                                           ║
 * ║ bank_import_commit() ends its text loop with                              ║
 * ║                                                                           ║
 * ║   delete from bank_question_texts                                         ║
 * ║    where question_id = v_qid and not (locale = any (v_locales))           ║
 * ║                                                                           ║
 * ║ — deliberately, so that a re-import can RETRACT a bad translation.        ║
 * ║ Anything absent from the payload is deleted.                              ║
 * ║                                                                           ║
 * ║ That has already destroyed real data once. An earlier version of the Easy ║
 * ║ importer re-sent only English and the locale it was adding, so importing  ║
 * ║ Gujarati deleted all 1,023 Hindi rows imported an hour earlier. The run   ║
 * ║ reported "1023 updated" and exited zero.                                  ║
 * ║                                                                           ║
 * ║ The fix is structural rather than a rule somebody has to remember: this   ║
 * ║ shape CANNOT express the other languages, so the merge has to happen on   ║
 * ║ the server, where the other languages can be read back from the bank.     ║
 * ║ See buildCommitRows() in src/server/actions/paper-import.ts.              ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * It is also what keeps the request small enough to exist: a Server Action body
 * is capped at 1 MB, and the file this feature was built for is 1 MB on its own.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** One question's new text, in one language. */
export interface PaperCommitRow {
  externalId: string
  /**
   * What the report decided. The server re-derives it from the bank rather than
   * trusting it — a client claiming `create` for an id that exists would
   * otherwise be asking for a second question with a duplicate id.
   */
  action: 'update' | 'create'

  question: string
  optionA: string | null
  optionB: string | null
  optionC: string | null
  optionD: string | null
  answerText: string | null
  explanation: string | null

  /**
   * ┌───────────────────────────────────────────────────────────────────────────┐
   * │ THE FOUR BELOW ARE ONLY READ FOR A QUESTION BEING CREATED.                │
   * │                                                                           │
   * │ For an update the server takes every one of them from the bank row and    │
   * │ discards what arrived here. That is a correctness rule before it is a     │
   * │ security one — a translated document has no difficulty, and its topic     │
   * │ heading is translated — but it is both: it means no client can retopic,   │
   * │ relevel or re-answer a question by editing a payload.                     │
   * └───────────────────────────────────────────────────────────────────────────┘
   */
  difficulty: Difficulty
  qtype: QuestionType
  topicSlug: string | null
  correctOption: OptionKey | null
}

export function toPaperCommitRow(question: PreparedQuestion): PaperCommitRow {
  return {
    externalId: question.externalId,
    action: question.action === 'create' ? 'create' : 'update',
    question: question.stem,
    optionA: question.optionA,
    optionB: question.optionB,
    optionC: question.optionC,
    optionD: question.optionD,
    answerText: question.answerText,
    explanation: question.explanation,
    difficulty: question.difficulty,
    qtype: question.qtype,
    topicSlug: question.topicSlug,
    correctOption: question.correctOption,
  }
}

/** Everything the report says will be written, in document order. */
export function paperCommitRows(report: PaperReport): PaperCommitRow[] {
  return report.questions
    .filter((question) => question.action !== 'skip')
    .map(toPaperCommitRow)
}

/**
 * How many questions go in one call.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ SMALLER THAN THE JSON IMPORTER'S 200, AND FOR A CONCRETE REASON.          │
 * │                                                                           │
 * │ Each row leaves the browser carrying ONE language and reaches Postgres    │
 * │ carrying every language the bank holds — three, for this bank. So the     │
 * │ statement is roughly three times the size of the request that produced    │
 * │ it, and the number that has to stay inside a statement timeout is the     │
 * │ former.                                                                   │
 * │                                                                           │
 * │ 100 is not a guess: it is the batch size at which the Easy and Medium     │
 * │ translations — the same 1,030-question workload against the same          │
 * │ function — have been imported successfully.                               │
 * │                                                                           │
 * │ Each batch is its own transaction, so a failure rolls that batch back     │
 * │ whole and never leaves a half-written question. Batches that already      │
 * │ committed stay committed, which is why the panel reports how far it got   │
 * │ and offers to resume: every row is keyed by externalId, so re-applying    │
 * │ one is an update, not a duplicate.                                        │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export const PAPER_IMPORT_BATCH_SIZE = 100

/**
 * Split into batches.
 *
 * Deliberately NOT reusing batchRows() from ../import/commit.ts. That module's
 * batch size is baked into the Server Action's max-length schema over there,
 * and sharing the splitter would invite sharing the constant — at which point
 * changing one importer's batching silently changes the other's validation cap.
 */
export function paperBatches<T>(rows: readonly T[], size: number = PAPER_IMPORT_BATCH_SIZE): T[][] {
  if (size < 1) throw new Error('Batch size must be at least 1.')

  const batches: T[][] = []
  for (let i = 0; i < rows.length; i += size) batches.push(rows.slice(i, i + size))
  return batches
}
