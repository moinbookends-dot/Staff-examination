import { describe, it, expect } from 'vitest'
import { analyseImport } from '@/lib/bank/import/analyse'
import { importQuestionSchema, REJECTION_REASONS } from '@/lib/bank/import/format'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * THE IMPORT CONTRACT IS FROZEN. THIS FILE IS THE LOCK.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ WHY THIS EXISTS SEPARATELY FROM bank-import.test.ts.                      ║
 * ║                                                                           ║
 * ║ That suite tests BEHAVIOUR and may legitimately grow as the importer      ║
 * ║ gains features. This one pins the AGREEMENT: the exact field set, the     ║
 * ║ exact defaults, and the six rules stated when the contract was frozen.    ║
 * ║                                                                           ║
 * ║ A 3,000-question dataset is being generated against this specification    ║
 * ║ right now, outside this repository. A change here does not cause a merge  ║
 * ║ conflict or a type error — it causes thousands of rows to stop importing, ║
 * ║ discovered by somebody holding a finished file.                           ║
 * ║                                                                           ║
 * ║ IF A TEST IN THIS FILE FAILS, THE CONTRACT HAS BEEN BROKEN. Do not update ║
 * ║ the assertion to match the code. Either revert the change, or get an      ║
 * ║ explicit decision to break the format and re-issue the specification.     ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** The canonical row. Every field the contract admits, in one object. */
const CANONICAL = {
  externalId: 'easy-0001',
  difficulty: 'easy',
  type: 'mcq',
  status: 'active',
  topic: 'food-safety',
  correctOption: 'C',
  reference: { document: 'A document title', page: 12 },
  en: {
    question: 'English question text',
    options: { A: 'Option A', B: 'Option B', C: 'Option C', D: 'Option D' },
    explanation: 'Why C is correct',
  },
  hi: {
    question: 'हिन्दी प्रश्न',
    options: { A: 'विकल्प A', B: 'विकल्प B', C: 'विकल्प C', D: 'विकल्प D' },
    explanation: 'कारण',
  },
  gu: {
    question: 'ગુજરાતી પ્રશ્ન',
    options: { A: 'ઓપ્શન A', B: 'ઓપ્શન B', C: 'ઓપ્શન C', D: 'ઓપ્શન D' },
    explanation: 'કારણ',
  },
}

const wrap = (...q: unknown[]) => JSON.stringify({ questions: q })

describe('FROZEN: the accepted field set', () => {
  it('accepts the canonical row with every field populated', () => {
    const report = analyseImport(wrap(CANONICAL), { knownTopics: ['food-safety'] })
    expect(report.rejected).toEqual([])
    expect(report.importedCount).toBe(1)
  })

  it('accepts exactly these top-level fields and no others', () => {
    /*
     * Both directions. Adding a field to the schema without updating the
     * published specification fails the first half; removing one that the
     * dataset already uses fails the second.
     */
    const expected = [
      'externalId',
      'difficulty',
      'type',
      'status',
      'topic',
      'correctOption',
      'reference',
      'en',
      'hi',
      'gu',
    ].sort()

    const actual = Object.keys(importQuestionSchema.shape).sort()
    expect(actual).toEqual(expected)
  })

  it('accepts exactly these per-language fields and no others', () => {
    const expected = ['question', 'options', 'answer', 'explanation'].sort()
    const actual = Object.keys(importQuestionSchema.shape.en.shape).sort()
    expect(actual).toEqual(expected)
  })

  it('still refuses an unknown key rather than dropping it', () => {
    // A generator emitting `answerText` instead of `answer` must be told, not
    // have the field discarded and the question imported answerless.
    const report = analyseImport(wrap({ ...CANONICAL, notAField: true }))
    expect(report.rejectedCount).toBe(1)
  })
})

describe('FROZEN 1: externalId is the permanent identifier', () => {
  it('is carried through onto the parsed question', () => {
    const report = analyseImport(wrap(CANONICAL), { knownTopics: ['food-safety'] })
    expect(report.toImport[0].externalId).toBe('easy-0001')
  })

  it('is carried onto a rejection so a bad row can still be located', () => {
    const report = analyseImport(wrap({ ...CANONICAL, difficulty: 'nope' }))
    expect(report.rejected[0].externalId).toBe('easy-0001')
  })

  it('remains optional — a dataset without it still imports', () => {
    const { externalId, ...anonymous } = CANONICAL
    void externalId
    const report = analyseImport(wrap(anonymous), { knownTopics: ['food-safety'] })
    expect(report.importedCount).toBe(1)
  })
})

describe('FROZEN 2: a matching externalId updates rather than duplicates', () => {
  it('routes a known externalId to toUpdate', () => {
    const report = analyseImport(wrap(CANONICAL), {
      knownTopics: ['food-safety'],
      existingExternalIds: ['easy-0001'],
    })

    expect(report.updatedCount).toBe(1)
    expect(report.importedCount).toBe(0)
    expect(report.toUpdate[0].externalId).toBe('easy-0001')
  })

  it('routes an unknown externalId to toImport', () => {
    const report = analyseImport(wrap(CANONICAL), {
      knownTopics: ['food-safety'],
      existingExternalIds: ['something-else'],
    })
    expect(report.importedCount).toBe(1)
    expect(report.updatedCount).toBe(0)
  })
})

describe('FROZEN 3: unknown topics are rejected, never auto-created', () => {
  it('rejects a topic that is not in the known list', () => {
    const report = analyseImport(wrap({ ...CANONICAL, topic: 'Not A Real Topic' }), {
      knownTopics: ['food-safety'],
    })

    expect(report.importedCount).toBe(0)
    expect(report.rejectionsByReason['unknown-topic']).toBe(1)
    expect(report.unknownTopics).toEqual(['Not A Real Topic'])
  })

  it('matches a known topic by slug or by display name', () => {
    for (const topic of ['food-safety', 'Food Safety', '  FOOD SAFETY  ']) {
      const report = analyseImport(wrap({ ...CANONICAL, topic }), {
        knownTopics: ['food-safety'],
      })
      expect(report.importedCount, `topic: ${topic}`).toBe(1)
    }
  })
})

describe('FROZEN 4: difficulty is taken exactly as provided', () => {
  it('stores each level unchanged', () => {
    for (const difficulty of ['easy', 'medium', 'hard'] as const) {
      const report = analyseImport(
        wrap({ ...CANONICAL, difficulty, en: { ...CANONICAL.en, question: `Q ${difficulty}` } }),
        { knownTopics: ['food-safety'] },
      )
      expect(report.toImport[0].difficulty).toBe(difficulty)
    }
  })

  it('has no default — a row without difficulty is rejected, not guessed', () => {
    /*
     * A default would be this software deciding a question's level. What Easy,
     * Medium and Hard mean is defined in a separate document owned by the
     * customer, and nothing here infers, adjusts or second-guesses it.
     */
    const { difficulty, ...noLevel } = CANONICAL
    void difficulty
    const report = analyseImport(wrap(noLevel), { knownTopics: ['food-safety'] })

    expect(report.importedCount).toBe(0)
    expect(report.rejectionsByReason['invalid-difficulty']).toBe(1)
  })

  it('never reassigns a level based on anything about the question', () => {
    // The same question text at three levels stays at three levels.
    const rows = (['easy', 'medium', 'hard'] as const).map((difficulty) => ({
      ...CANONICAL,
      externalId: `x-${difficulty}`,
      difficulty,
    }))
    const report = analyseImport(wrap(...rows), { knownTopics: ['food-safety'] })

    expect(report.countsByDifficulty).toEqual({ easy: 1, medium: 1, hard: 1 })
  })
})

describe('FROZEN 5: status defaults to active, falling back to draft only on validation', () => {
  it('defaults to active when absent', () => {
    const { status, ...noStatus } = CANONICAL
    void status
    const report = analyseImport(wrap(noStatus), { knownTopics: ['food-safety'] })
    expect(report.toImport[0].status).toBe('active')
  })

  it('falls back to draft when a required language is missing', () => {
    const { gu, ...noGujarati } = CANONICAL
    void gu
    const report = analyseImport(wrap(noGujarati), {
      knownTopics: ['food-safety'],
      requiredLocales: ['en', 'hi', 'gu'],
    })

    expect(report.toImport[0].status).toBe('draft')
    expect(report.downgradedToDraftCount).toBe(1)
    // The row survives. It is never rejected for a missing translation.
    expect(report.rejectedCount).toBe(0)
  })

  it('does not fall back when everything required is present', () => {
    const report = analyseImport(wrap(CANONICAL), {
      knownTopics: ['food-safety'],
      requiredLocales: ['en', 'hi', 'gu'],
    })
    expect(report.toImport[0].status).toBe('active')
    expect(report.downgradedToDraftCount).toBe(0)
  })

  it('never promotes a draft to active', () => {
    // The fallback is one-directional. Nothing here upgrades a status.
    const report = analyseImport(wrap({ ...CANONICAL, status: 'draft' }), {
      knownTopics: ['food-safety'],
    })
    expect(report.toImport[0].status).toBe('draft')
  })
})

describe('FROZEN 6: every report category is always present', () => {
  const CATEGORIES = [
    'importedCount',
    'updatedCount',
    'rejectedCount',
    'duplicateCount',
    'missingTranslations',
    'unknownTopics',
    'rejectionsByReason',
  ] as const

  it('reports every category even on a clean file', () => {
    // A zero is information: it says the category was checked and was clean.
    // Omitting it would make "no unknown topics" indistinguishable from
    // "unknown topics were not looked for".
    const report = analyseImport(wrap(CANONICAL), { knownTopics: ['food-safety'] })

    for (const key of CATEGORIES) {
      expect(report[key], `missing category: ${key}`).toBeDefined()
    }
    expect(report.rejectionsByReason['invalid-difficulty']).toBe(0)
    expect(report.rejectionsByReason['invalid-option-structure']).toBe(0)
  })

  it('reports every category on a fatal file too', () => {
    const report = analyseImport('not json at all')
    for (const key of CATEGORIES) {
      expect(report[key], `missing category: ${key}`).toBeDefined()
    }
  })

  it('carries a counter for every declared rejection reason', () => {
    const report = analyseImport(wrap(CANONICAL), { knownTopics: ['food-safety'] })
    for (const reason of REJECTION_REASONS) {
      expect(report.rejectionsByReason[reason], `missing reason: ${reason}`).toBe(0)
    }
  })

  it('surfaces the two named causes distinctly', () => {
    // "Invalid difficulty" and "invalid option structure" were called out by
    // name when the contract was frozen, so they are asserted by name.
    const report = analyseImport(
      wrap(
        { ...CANONICAL, externalId: 'a', difficulty: 'wrong' },
        { ...CANONICAL, externalId: 'b', en: { question: 'No options at all' } },
      ),
      { knownTopics: ['food-safety'] },
    )

    expect(report.rejectionsByReason['invalid-difficulty']).toBe(1)
    expect(report.rejectionsByReason['invalid-option-structure']).toBe(1)
  })

  it('reports duplicates separately from rejections', () => {
    // Different fixes: a rejected row needs correcting, a duplicate needs
    // deleting. Merging them would obscure both.
    const report = analyseImport(wrap(CANONICAL, { ...CANONICAL, externalId: 'other' }), {
      knownTopics: ['food-safety'],
    })

    expect(report.duplicateCount).toBe(1)
    expect(report.rejectedCount).toBe(0)
    expect(report.importedCount).toBe(1)
  })
})
