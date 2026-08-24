import { describe, it, expect } from 'vitest'
import { analyseImport } from '@/lib/bank/import/analyse'
import { questionKey } from '@/lib/bank/import/format'
import { toCommitRow } from '@/lib/bank/import/commit'
import type { QuestionType } from '@/lib/bank/vocabulary'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Adding a language to a bank that is already there.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE BUG THIS PINS: 1,000 QUESTIONS RE-IMPORTED AS 1,000 NEW ONES.        ║
 * ║                                                                           ║
 * ║ The importer could only recognise a question by its externalId. Capiche's ║
 * ║ 1,000 questions were imported without ids, so a re-import carrying Hindi  ║
 * ║ matched nothing, every row counted as new, and the commit then collided   ║
 * ║ with bank_question_texts_dedupe_uq and rolled the whole batch back.       ║
 * ║                                                                           ║
 * ║ These tests describe the BANK as a list of keys, which is exactly what    ║
 * ║ loadImportOptions ships to the browser — so what is asserted here is what ║
 * ║ the screen computes, not a parallel model of it.                          ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** One question, as a curator's file would carry it. English only. */
const english = (n: number) => ({
  difficulty: 'easy' as const,
  type: 'mcq' as const,
  // An MCQ without one is rejected before matching is ever considered.
  correctOption: 'B' as const,
  en: {
    question: `How much mozzarella is used in the ${n}-inch pizza?`,
    options: { A: '100 g', B: '150 g', C: '200 g', D: '250 g' },
  },
})

/** The same question, with a Hindi block added. Nothing else changes. */
const withHindi = (n: number) => ({
  ...english(n),
  hi: {
    question: `${n}-इंच पिज़्ज़ा में कितना मोज़रेला उपयोग होता है?`,
    options: { A: '100 ग्राम', B: '150 ग्राम', C: '200 ग्राम', D: '250 ग्राम' },
  },
})

const wrap = (questions: unknown[]) => JSON.stringify({ questions })

/** The bank, in the shape loadImportOptions returns. */
const bankOf = (rows: { difficulty: string; en: { question: string } }[], qtype: QuestionType = 'mcq') =>
  rows.map((r) => ({ key: questionKey(r.difficulty, r.en.question), qtype }))

const THOUSAND = Array.from({ length: 1000 }, (_, i) => i + 1)

describe('a language added to an existing bank', () => {
  it('imports 1,000 English questions as new when the bank is empty', () => {
    const report = analyseImport(wrap(THOUSAND.map(english)), {
      existingQuestions: [],
      requiredLocales: ['en'],
    })

    expect(report.importedCount).toBe(1000)
    expect(report.updatedCount).toBe(0)
    expect(report.duplicateCount).toBe(0)
    expect(report.rejectedCount).toBe(0)
  })

  it('re-imports the same 1,000 with Hindi as 1,000 UPDATES, not 1,000 new', () => {
    // The bank now holds exactly what the first import wrote.
    const bank = bankOf(THOUSAND.map(english))

    const report = analyseImport(wrap(THOUSAND.map(withHindi)), {
      existingQuestions: bank,
      requiredLocales: ['en'],
    })

    expect(report.importedCount).toBe(0)
    expect(report.updatedCount).toBe(1000)
    expect(report.duplicateCount).toBe(0)
    expect(report.rejectedCount).toBe(0)

    // Every row carries both languages through to the commit, so the Hindi
    // actually reaches the question rather than being counted and dropped.
    expect(report.toUpdate).toHaveLength(1000)
    for (const question of report.toUpdate) {
      expect(question.en).toBeDefined()
      expect(question.hi).toBeDefined()
    }

    const rows = report.toUpdate.map(toCommitRow)
    for (const row of rows) {
      const locales = row.texts.map((t) => t.locale).sort()
      expect(locales).toEqual(['en', 'hi'])
    }
  })

  it('counts a mixed file honestly — some already here, some not', () => {
    // The first 600 exist; the file also carries 400 that do not.
    const bank = bankOf(THOUSAND.slice(0, 600).map(english))

    const report = analyseImport(wrap(THOUSAND.map(withHindi)), {
      existingQuestions: bank,
      requiredLocales: ['en'],
    })

    expect(report.updatedCount).toBe(600)
    expect(report.importedCount).toBe(400)
    expect(report.rejectedCount).toBe(0)
    expect(report.updatedCount + report.importedCount).toBe(1000)
  })

  it('still matches when the file differs only in spacing or case', () => {
    const bank = bankOf([english(11)])

    const messy = {
      ...withHindi(11),
      en: { ...withHindi(11).en, question: `  HOW MUCH MOZZARELLA IS USED IN THE 11-INCH PIZZA?  ` },
    }

    const report = analyseImport(wrap([messy]), {
      existingQuestions: bank,
      requiredLocales: ['en'],
    })

    expect(report.updatedCount).toBe(1)
    expect(report.importedCount).toBe(0)
  })

  it('matches across Unicode normalisation forms', () => {
    // The same word, composed and decomposed. A reader sees one question; the
    // importer has to as well, or a re-import duplicates every accented row.
    const composed = 'What is the garnish for the Crème Brûlée?'.normalize('NFC')
    const decomposed = composed.normalize('NFD')
    expect(composed).not.toBe(decomposed)

    const bank = [{ key: questionKey('easy', composed), qtype: 'mcq' as const }]

    const report = analyseImport(
      wrap([
        {
          difficulty: 'easy',
          type: 'mcq',
          correctOption: 'B',
          en: {
            question: decomposed,
            options: { A: 'Mint', B: 'Berries', C: 'Sugar', D: 'Cream' },
          },
        },
      ]),
      { existingQuestions: bank, requiredLocales: ['en'] },
    )

    expect(report.updatedCount).toBe(1)
    expect(report.importedCount).toBe(0)
  })
})

describe('what matching must NOT do', () => {
  it('does not match a question in another level', () => {
    // difficulty is part of the key, and of the database's unique index.
    const bank = bankOf(THOUSAND.slice(0, 10).map(english))

    const harder = THOUSAND.slice(0, 10).map((n) => ({
      ...withHindi(n),
      difficulty: 'hard' as const,
    }))

    const report = analyseImport(wrap(harder), {
      existingQuestions: bank,
      requiredLocales: ['en'],
    })

    expect(report.importedCount).toBe(10)
    expect(report.updatedCount).toBe(0)
  })

  it('refuses a match whose type disagrees, by name, without failing the file', () => {
    /*
     * The bank holds this text as a short answer; the file calls it an MCQ.
     * Converting it would rewrite the answer shape underneath the stored text
     * and the database would refuse the half-changed state — so the row is
     * rejected and named, and the other 999 still import.
     */
    const bank = bankOf([english(11)], 'short_answer')

    // Everything EXCEPT 11, or the file would carry 11 twice and the second
    // copy would be a within-file duplicate rather than a clean import.
    const rest = THOUSAND.filter((n) => n !== 11).map(english)

    const report = analyseImport(wrap([withHindi(11), ...rest]), {
      existingQuestions: bank,
      requiredLocales: ['en'],
    })

    expect(report.rejectionsByReason['type-conflict']).toBe(1)
    expect(report.rejected[0].issues[0]).toMatch(/already in the bank/i)
    // The rest of the file is unaffected — one bad row is not a failed import.
    expect(report.importedCount).toBe(999)
  })

  it('keeps within-file duplicates separate from bank matches', () => {
    // The same question twice in one file is still a duplicate, whether or not
    // the bank already holds it — the second copy would overwrite the first.
    const bank = bankOf([english(11)])

    const report = analyseImport(wrap([withHindi(11), withHindi(11)]), {
      existingQuestions: bank,
      requiredLocales: ['en'],
    })

    expect(report.updatedCount).toBe(1)
    expect(report.duplicateCount).toBe(1)
    expect(report.importedCount).toBe(0)
  })

  it('reads everything as new when the caller supplies no bank', () => {
    // The pre-existing behaviour, and correct for a first import.
    const report = analyseImport(wrap(THOUSAND.slice(0, 50).map(english)), {
      requiredLocales: ['en'],
    })

    expect(report.importedCount).toBe(50)
    expect(report.updatedCount).toBe(0)
  })
})

describe('externalId still wins where there is one', () => {
  it('matches by id even when the English text was edited', () => {
    // A corrected typo must not create a second question. The id is the
    // stronger claim and is checked first.
    const report = analyseImport(
      wrap([
        {
          externalId: 'cap-0001',
          difficulty: 'easy',
          type: 'mcq',
          correctOption: 'B',
          en: {
            question: 'A corrected version of the question text',
            options: { A: 'A', B: 'B', C: 'C', D: 'D' },
          },
        },
      ]),
      {
        existingExternalIds: ['cap-0001'],
        existingQuestions: bankOf([english(11)]),
        requiredLocales: ['en'],
      },
    )

    expect(report.updatedCount).toBe(1)
    expect(report.importedCount).toBe(0)
  })
})
