import { describe, it, expect } from 'vitest'
import { analyseImport } from '@/lib/bank/import/analyse'
import { importQuestionSchema } from '@/lib/bank/import/format'
import { toCommitRow } from '@/lib/bank/import/commit'
import {
  exportFilename,
  toExportEnvelope,
  toExportQuestion,
  type ExportRow,
} from '@/lib/bank/import/export'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE ROUND TRIP.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ An export the importer would reject is not a backup. These tests take     ║
 * ║ the exporter's output and feed it straight back through analyseImport(),  ║
 * ║ which is the same function the real screen runs — so "it round-trips" is  ║
 * ║ demonstrated rather than asserted in a comment.                           ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */

const MCQ_ROW: ExportRow = {
  externalId: 'e-0001',
  difficulty: 'easy',
  qtype: 'mcq',
  status: 'active',
  topicSlug: 'food-safety',
  correctOption: 'C',
  referenceTitle: 'The Cookbook',
  referencePage: 42,
  texts: [
    {
      locale: 'en',
      question: 'First question',
      optionA: 'Alpha',
      optionB: 'Bravo',
      optionC: 'Charlie',
      optionD: 'Delta',
      answerText: null,
      explanation: 'Because Charlie.',
    },
    {
      locale: 'hi',
      question: 'पहला प्रश्न',
      optionA: 'अ',
      optionB: 'ब',
      optionC: 'स',
      optionD: 'द',
      answerText: null,
      explanation: null,
    },
  ],
}

const SHORT_ROW: ExportRow = {
  externalId: null,
  difficulty: 'hard',
  qtype: 'short_answer',
  status: 'draft',
  topicSlug: null,
  correctOption: null,
  referenceTitle: null,
  referencePage: null,
  texts: [
    {
      locale: 'en',
      question: 'Second question',
      optionA: null,
      optionB: null,
      optionC: null,
      optionD: null,
      answerText: 'An answer',
      explanation: null,
    },
  ],
}

/*
 * Distinct English text, and that is not incidental.
 *
 * dedupeKey() is `difficulty::lower(english question)`, mirroring
 * bank_question_texts_dedupe_uq — (brand_id, difficulty, lower(question))
 * where locale = 'en'. Two rows sharing both, as an earlier version of this
 * fixture did, are the SAME question as far as both the index and the report
 * are concerned, and the database could not have produced them within a brand.
 */
const ARCHIVED_ROW: ExportRow = {
  ...SHORT_ROW,
  externalId: 'e-0003',
  status: 'archived',
  texts: [{ ...SHORT_ROW.texts[0], question: 'Third question' }],
}

describe('every exported question is accepted by the importer', () => {
  it('accepts each question against the frozen schema', () => {
    for (const row of [MCQ_ROW, SHORT_ROW, ARCHIVED_ROW]) {
      const result = importQuestionSchema.safeParse(toExportQuestion(row))
      expect(result.success, JSON.stringify(result.error?.issues)).toBe(true)
    }
  })

  it('re-imports a whole export with nothing rejected', () => {
    const envelope = toExportEnvelope([MCQ_ROW, SHORT_ROW, ARCHIVED_ROW], {
      brand: 'aiko',
      exportedAt: '2026-08-08T00:00:00.000Z',
    })

    const report = analyseImport(JSON.stringify(envelope), {
      knownTopics: ['food-safety'],
      requiredLocales: ['en'],
    })

    expect(report.fatal).toBeUndefined()
    expect(report.rejected).toEqual([])
    expect(report.duplicates).toEqual([])
    expect(report.importedCount).toBe(3)
  })

  it('recognises its own questions as updates on a second import', () => {
    // The reason externalId is exported at all: restoring a backup must not
    // duplicate the bank it was taken from.
    const envelope = toExportEnvelope([MCQ_ROW, ARCHIVED_ROW], {
      exportedAt: '2026-08-08T00:00:00.000Z',
    })

    const report = analyseImport(JSON.stringify(envelope), {
      knownTopics: ['food-safety'],
      existingExternalIds: ['e-0001', 'e-0003'],
    })

    expect(report.updatedCount).toBe(2)
    expect(report.importedCount).toBe(0)
  })

  it('survives a full export → import → commit cycle unchanged', () => {
    const envelope = toExportEnvelope([MCQ_ROW], { exportedAt: '2026-08-08T00:00:00.000Z' })
    const report = analyseImport(JSON.stringify(envelope), { knownTopics: ['food-safety'] })
    const back = toCommitRow(report.toImport[0])

    // Everything that identifies the question, and everything that decides what
    // is correct, has to come back identical.
    expect(back.externalId).toBe(MCQ_ROW.externalId)
    expect(back.difficulty).toBe(MCQ_ROW.difficulty)
    expect(back.qtype).toBe(MCQ_ROW.qtype)
    expect(back.status).toBe(MCQ_ROW.status)
    expect(back.topicSlug).toBe(MCQ_ROW.topicSlug)
    expect(back.correctOption).toBe(MCQ_ROW.correctOption)
    expect(back.referenceTitle).toBe(MCQ_ROW.referenceTitle)
    expect(back.referencePage).toBe(MCQ_ROW.referencePage)
    expect(back.texts).toEqual(MCQ_ROW.texts)
  })
})

/**
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHY THE EXPORT IS SCOPED TO ONE BRAND.                                    │
 * │                                                                           │
 * │ 0054 made brand_id NOT NULL with no "shared across brands" and recorded   │
 * │ the accepted cost: a question that applies to every brand is stored once  │
 * │ PER BRAND, with identical English text. Within a brand the unique index   │
 * │ makes that impossible, so a single-brand export can never contain a       │
 * │ duplicate pair — but an ALL-BRANDS export routinely would, and re-        │
 * │ importing it into one brand would report most of it as duplicates.        │
 * │                                                                           │
 * │ That is why the route takes a brand. This test pins the behaviour so the  │
 * │ constraint is documented rather than rediscovered.                        │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
describe('brand scoping', () => {
  it('reports cross-brand copies as duplicates when merged into one file', () => {
    const aiko = MCQ_ROW
    const capiche = { ...MCQ_ROW, externalId: 'e-0001-capiche' }

    const merged = toExportEnvelope([aiko, capiche], { exportedAt: '2026-08-08T00:00:00.000Z' })
    const report = analyseImport(JSON.stringify(merged), { knownTopics: ['food-safety'] })

    expect(report.duplicateCount).toBe(1)
    expect(report.importedCount).toBe(1)
  })

  it('round-trips cleanly when the export is one brand', () => {
    const single = toExportEnvelope([MCQ_ROW], { exportedAt: '2026-08-08T00:00:00.000Z' })
    const report = analyseImport(JSON.stringify(single), { knownTopics: ['food-safety'] })

    expect(report.duplicateCount).toBe(0)
    expect(report.importedCount).toBe(1)
  })
})

describe('what the export deliberately does and does not carry', () => {
  it('never emits a database UUID', () => {
    // Not in the contract, refused by the strict schema, and gated by
    // canSeeQuestionUuid — an export carrying it would route around that.
    const json = JSON.stringify(toExportQuestion(MCQ_ROW))
    expect(json).not.toMatch(/"id"|"rowKey"|"questionId"/)
  })

  it('omits absent optional fields rather than emitting null', () => {
    // importQuestionSchema is .strict() with .optional() fields: `topic: null`
    // fails where a missing `topic` passes.
    const short = toExportQuestion(SHORT_ROW) as Record<string, unknown>

    expect('externalId' in short).toBe(false)
    expect('topic' in short).toBe(false)
    expect('correctOption' in short).toBe(false)
    expect('reference' in short).toBe(false)
  })

  it('does not invent an externalId for a question that has none', () => {
    // Pressing Download must not mint a permanent identifier as a side effect.
    expect((toExportQuestion(SHORT_ROW) as Record<string, unknown>).externalId).toBeUndefined()
  })

  it('exports archived questions as archived, which is why the schema accepts it', () => {
    expect(toExportQuestion(ARCHIVED_ROW).status).toBe('archived')
    expect(importQuestionSchema.safeParse(toExportQuestion(ARCHIVED_ROW)).success).toBe(true)
  })

  it('gives an MCQ options and no answer, and a short answer the reverse', () => {
    const mcq = toExportQuestion(MCQ_ROW)
    expect(mcq.en.options).toEqual({ A: 'Alpha', B: 'Bravo', C: 'Charlie', D: 'Delta' })
    expect(mcq.en.answer).toBeUndefined()

    const short = toExportQuestion(SHORT_ROW)
    expect(short.en.answer).toBe('An answer')
    expect(short.en.options).toBeUndefined()
  })

  it('keeps the explanation per language', () => {
    const mcq = toExportQuestion(MCQ_ROW)
    expect(mcq.en.explanation).toBe('Because Charlie.')
    expect(mcq.hi?.explanation).toBeUndefined()
  })

  it('emits a reference page only alongside its document', () => {
    // bank_q_page_needs_document refuses a page with no document, and
    // shapeIssues() rejects the same combination on the way in.
    const orphan = toExportQuestion({ ...MCQ_ROW, referenceTitle: null, referencePage: 9 })
    expect(orphan.reference).toBeUndefined()
  })

  it('stamps the format version the importer checks', () => {
    const envelope = toExportEnvelope([], { exportedAt: '2026-08-08T00:00:00.000Z' })
    expect(envelope.formatVersion).toBe(1)
    expect(envelope.questions).toEqual([])
  })
})

describe('exportFilename', () => {
  it('names the brand and the date', () => {
    expect(exportFilename('Aiko', '2026-08-08T12:00:00.000Z')).toBe(
      'bookends-questions-aiko-2026-08-08.json',
    )
  })

  it('slugifies a brand with spaces and punctuation', () => {
    expect(exportFilename('Capiche & Co.', '2026-08-08T00:00:00.000Z')).toBe(
      'bookends-questions-capiche-co-2026-08-08.json',
    )
  })

  it('falls back to "all" when no brand is named', () => {
    expect(exportFilename(null, '2026-08-08T00:00:00.000Z')).toBe(
      'bookends-questions-all-2026-08-08.json',
    )
  })

  it('never produces a filename with a path separator in it', () => {
    const name = exportFilename('a/b\\c', '2026-08-08T00:00:00.000Z')
    expect(name).not.toMatch(/[/\\]/)
  })
})
