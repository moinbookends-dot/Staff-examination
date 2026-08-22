import { BANK_LOCALES } from '../vocabulary'
import { IMPORT_FORMAT_VERSION, type ImportQuestion, type ImportText } from './format'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Export — the same contract, read backwards.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ WHAT COMES OUT MUST GO BACK IN. THAT IS THE ENTIRE SPECIFICATION.         ║
 * ║                                                                           ║
 * ║ An export in a shape the importer would reject is not a backup, it is a   ║
 * ║ report — and it would be discovered to be one on the day somebody tried   ║
 * ║ to restore from it. So this emits the canonical envelope, and the         ║
 * ║ round-trip is asserted in tests/unit/bank-export.test.ts by feeding the   ║
 * ║ output straight back through analyseImport().                             ║
 * ║                                                                           ║
 * ║ Two consequences that look like quirks and are not:                       ║
 * ║                                                                           ║
 * ║  · `archived` is emitted as-is. format.ts accepts it FOR THIS REASON      ║
 * ║    ("accepted so an export can round-trip"), even though no generated     ║
 * ║    dataset should contain one.                                            ║
 * ║  · a question with no externalId gets none. Inventing one here would mint ║
 * ║    a permanent identifier as a side effect of pressing Download, and the  ║
 * ║    next import would treat it as authoritative.                           ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * The database UUID is deliberately absent from the output. It is not part of
 * the contract, it is not accepted on import (the schema is `.strict()`), and
 * bank-access.ts treats it as something only an Editor may see — an export
 * carrying it would route around that rule via a file.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** One row as it comes back from the database, before transposition. */
export interface ExportRow {
  externalId: string | null
  difficulty: string
  qtype: string
  status: string
  topicSlug: string | null
  correctOption: string | null
  referenceTitle: string | null
  referencePage: number | null
  texts: {
    locale: string
    question: string
    optionA: string | null
    optionB: string | null
    optionC: string | null
    optionD: string | null
    answerText: string | null
    explanation: string | null
  }[]
}

export interface ExportEnvelope {
  formatVersion: number
  brand?: string
  exportedAt: string
  questions: ImportQuestion[]
}

/**
 * One row, transposed back into the contract's nested shape.
 *
 * Keys are omitted rather than set to null throughout, because
 * importQuestionSchema is `.strict()` and every optional field is `.optional()`
 * — `{ topic: null }` is a validation failure where a missing `topic` is fine.
 * This is the mirror image of toCommitRow(), which spells null out explicitly
 * because SQL cannot tell absent from null.
 */
export function toExportQuestion(row: ExportRow): ImportQuestion {
  const question: Record<string, unknown> = {
    difficulty: row.difficulty,
    type: row.qtype,
    status: row.status,
  }

  if (row.externalId) question.externalId = row.externalId
  if (row.topicSlug) question.topic = row.topicSlug
  if (row.correctOption) question.correctOption = row.correctOption

  if (row.referenceTitle) {
    question.reference = row.referencePage
      ? { document: row.referenceTitle, page: row.referencePage }
      : { document: row.referenceTitle }
  }

  for (const locale of BANK_LOCALES) {
    const text = row.texts.find((t) => t.locale === locale)
    if (!text) continue

    const out: ImportText = { question: text.question }

    // An MCQ carries options and no answer; a short answer the reverse. Emitting
    // both would be refused by shapeIssues() on the way back in.
    if (row.qtype === 'mcq') {
      if (text.optionA && text.optionB && text.optionC && text.optionD) {
        out.options = { A: text.optionA, B: text.optionB, C: text.optionC, D: text.optionD }
      }
    } else if (text.answerText) {
      out.answer = text.answerText
    }

    if (text.explanation) out.explanation = text.explanation

    question[locale] = out
  }

  return question as unknown as ImportQuestion
}

/**
 * The canonical envelope, which is the shape the importer prefers.
 *
 * `exportedAt` is extra rather than contractual — importEnvelopeSchema is not
 * strict at the envelope level, so an unknown key there is ignored on the way
 * back in. It would NOT be safe on a question, where the schema is strict.
 */
export function toExportEnvelope(
  rows: ExportRow[],
  options: { brand?: string; exportedAt: string },
): ExportEnvelope {
  return {
    formatVersion: IMPORT_FORMAT_VERSION,
    ...(options.brand ? { brand: options.brand } : {}),
    exportedAt: options.exportedAt,
    questions: rows.map(toExportQuestion),
  }
}

/** `bookends-questions-aiko-2026-08-08.json` */
export function exportFilename(brand: string | null, isoDate: string): string {
  const slug = (brand ?? 'all')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return `bookends-questions-${slug || 'all'}-${isoDate.slice(0, 10)}.json`
}
