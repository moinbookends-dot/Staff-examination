import { describe, it, expect } from 'vitest'
import { analyseImport, extractRows, isImportable, difficultyBalance } from '@/lib/bank/import/analyse'
import { dedupeKey, topicSlug } from '@/lib/bank/import/format'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The import contract.
 *
 * The 3,000-question dataset is generated outside this application, so this
 * schema is the entire agreement between the two halves — and these tests are
 * what stop it drifting. Everything asserted here is something a generation
 * process could plausibly get wrong at scale.
 *
 * The content below is minimal scaffolding: no cookbook material, no plausible
 * exam questions. Strings are neutral because the point is the SHAPE.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const MCQ = {
  externalId: 'e-0001',
  difficulty: 'easy',
  type: 'mcq',
  topic: 'food-safety',
  correctOption: 'C',
  en: {
    question: 'First question',
    options: { A: 'Alpha', B: 'Bravo', C: 'Charlie', D: 'Delta' },
  },
}

const SHORT = {
  externalId: 'e-0002',
  difficulty: 'hard',
  type: 'short_answer',
  en: { question: 'Second question', answer: 'An answer' },
}

const wrap = (...questions: unknown[]) => JSON.stringify({ questions })

describe('accepted file shapes', () => {
  it('accepts the canonical envelope', () => {
    const report = analyseImport(wrap(MCQ))
    expect(report.importedCount).toBe(1)
  })

  it('accepts a bare array', () => {
    const report = analyseImport(JSON.stringify([MCQ, SHORT]))
    expect(report.importedCount).toBe(2)
  })

  it('accepts JSON Lines', () => {
    // What a streamed generation process naturally emits.
    const jsonl = `${JSON.stringify(MCQ)}\n${JSON.stringify(SHORT)}`
    const report = analyseImport(jsonl)
    expect(report.importedCount).toBe(2)
  })

  it('reports an empty file rather than crashing', () => {
    expect(analyseImport('   ').fatal).toMatch(/empty/i)
  })

  it('explains what was expected when the JSON is not a question list', () => {
    // "Unexpected token" tells somebody with a 3,000-row file nothing.
    const report = analyseImport(JSON.stringify({ data: [] }))
    expect(report.fatal).toMatch(/questions/i)
  })

  it('names the offending line for malformed JSON Lines', () => {
    const report = analyseImport(`${JSON.stringify(MCQ)}\nnot json at all`)
    expect(report.fatal).toMatch(/line 2/)
  })

  it('does not mistake a pretty-printed object for JSON Lines', () => {
    const report = analyseImport(JSON.stringify({ questions: [MCQ] }, null, 2))
    expect(report.importedCount).toBe(1)
  })
})

describe('row validation', () => {
  it('accepts a well-formed MCQ and short answer', () => {
    const report = analyseImport(wrap(MCQ, SHORT))
    expect(report.rejected).toEqual([])
    expect(report.countsByType).toEqual({ mcq: 1, short_answer: 1 })
  })

  it('reports the row number, 1-based', () => {
    const report = analyseImport(wrap(MCQ, { ...MCQ, difficulty: 'impossible' }))
    expect(report.rejected[0].row).toBe(2)
  })

  it('carries the externalId onto the error so the row can be found', () => {
    const bad = { ...MCQ, externalId: 'e-9999', difficulty: 'nope' }
    const report = analyseImport(wrap(bad))
    expect(report.rejected[0].externalId).toBe('e-9999')
  })

  it('reports EVERY problem with a row, not just the first', () => {
    // Somebody fixing a generator needs the whole list or they run it five times.
    const bad = { difficulty: 'easy', type: 'mcq', en: { question: 'Missing its options' } }
    const report = analyseImport(wrap(bad))
    expect(report.rejected[0].issues.length).toBeGreaterThan(1)
  })

  it('points at the exact field with a path prefix', () => {
    const bad = {
      ...MCQ,
      hi: { question: 'ok', options: { A: 'a', B: 'b', C: '', D: 'd' } },
    }
    const report = analyseImport(wrap(bad))
    expect(report.rejected[0].issues.join(' ')).toMatch(/hi\.options\.C/)
  })

  it('rejects an unknown key rather than dropping it silently', () => {
    // A generator emitting `answerText` instead of `answer` must be told,
    // not have the field quietly discarded and the question imported answerless.
    const report = analyseImport(wrap({ ...SHORT, en: { ...SHORT.en, answerText: 'x' } }))
    expect(report.rejectedCount).toBe(1)
  })
})

describe('type and shape rules', () => {
  it('requires correctOption on an MCQ', () => {
    const { correctOption, ...noKey } = MCQ
    void correctOption
    const report = analyseImport(wrap(noKey))
    expect(report.rejected[0].issues.join(' ')).toMatch(/correctOption/)
  })

  it('refuses correctOption on a short answer', () => {
    const report = analyseImport(wrap({ ...SHORT, correctOption: 'A' }))
    expect(report.rejected[0].issues.join(' ')).toMatch(/must not have correctOption/)
  })

  it('requires four options on an MCQ, in every language supplied', () => {
    const report = analyseImport(wrap({ ...MCQ, hi: { question: 'हिन्दी प्रश्न' } }))
    expect(report.rejected[0].issues.join(' ')).toMatch(/hi: an MCQ needs all four options/)
  })

  it('refuses options on a short answer', () => {
    const bad = {
      ...SHORT,
      en: {
        question: 'A short answer carrying options',
        answer: 'An answer',
        options: { A: 'a', B: 'b', C: 'c', D: 'd' },
      },
    }
    const report = analyseImport(wrap(bad))
    expect(report.rejected[0].issues.join(' ')).toMatch(/must not have options/)
  })

  it('requires an answer on a short answer', () => {
    const report = analyseImport(wrap({ ...SHORT, en: { question: 'A question with no answer' } }))
    expect(report.rejected[0].issues.join(' ')).toMatch(/needs an answer/)
  })

  it('requires a document for a reference page', () => {
    const report = analyseImport(wrap({ ...MCQ, reference: { page: 12 } }))
    expect(report.rejected[0].issues.join(' ')).toMatch(/reference document/)
  })

  it('enforces the two-line answer cap', () => {
    const long = {
      ...SHORT,
      en: { question: 'A question with a very long answer', answer: 'x'.repeat(401) },
    }
    const report = analyseImport(wrap(long))
    expect(report.rejectedCount).toBe(1)
    expect(report.rejectionsByReason['invalid-answer']).toBe(1)
  })
})

describe('languages', () => {
  it('requires English and allows the others to be absent', () => {
    /*
     * Not because translations are optional in the product, but because the
     * required SET is a per-company setting starting at {en}. Demanding three
     * here would hard-code a rule the database made configurable and refuse a
     * perfectly good English-first dataset.
     */
    const report = analyseImport(wrap(MCQ))
    expect(report.importedCount).toBe(1)
    expect(report.localeCoverage).toEqual({ en: 1, hi: 0, gu: 0 })
  })

  it('refuses a row with no English at all', () => {
    const { en, ...noEnglish } = MCQ
    void en
    const report = analyseImport(wrap({ ...noEnglish, hi: MCQ.en }))
    expect(report.rejectedCount).toBe(1)
  })

  it('counts coverage per language across the file', () => {
    // Distinct English text, or the duplicate check correctly rejects it and
    // the coverage numbers describe two rows rather than three.
    const trilingual = {
      ...MCQ,
      externalId: 'e-3',
      en: { ...MCQ.en, question: 'A third question' },
      hi: MCQ.en,
      gu: MCQ.en,
    }
    const report = analyseImport(wrap(MCQ, { ...SHORT }, trilingual))
    expect(report.localeCoverage.en).toBe(3)
    expect(report.localeCoverage.hi).toBe(1)
    expect(report.localeCoverage.gu).toBe(1)
  })

  it('accepts real Devanagari and Gujarati without mangling them', () => {
    const q = {
      ...MCQ,
      hi: { question: 'यह एक प्रश्न है', options: { A: 'क', B: 'ख', C: 'ग', D: 'घ' } },
      gu: { question: 'આ એક પ્રશ્ન છે', options: { A: 'ક', B: 'ખ', C: 'ગ', D: 'ઘ' } },
    }
    const report = analyseImport(wrap(q))
    expect(report.importedCount).toBe(1)
    expect(report.toImport[0].hi?.question).toBe('यह एक प्रश्न है')
    expect(report.toImport[0].gu?.options?.C).toBe('ગ')
  })
})

describe('topics', () => {
  it('normalises names and slugs to the same thing', () => {
    expect(topicSlug('Food Safety')).toBe('food-safety')
    expect(topicSlug('food-safety')).toBe('food-safety')
    expect(topicSlug('  Kitchen   Equipment  ')).toBe('kitchen-equipment')
  })

  it('reports an unknown topic instead of creating it', () => {
    /*
     * At 3,000 rows a typo would otherwise quietly produce "Food Safty" as a
     * fifteenth topic, and nobody would notice until they filtered by it.
     */
    const report = analyseImport(wrap({ ...MCQ, topic: 'Food Safty' }), {
      knownTopics: ['food-safety'],
    })
    expect(report.rejected[0].issues.join(' ')).toMatch(/Unknown topic/)
    expect(report.rejected[0].reason).toBe('unknown-topic')
    expect(report.unknownTopics).toEqual(['Food Safty'])
  })

  it('accepts a known topic by display name', () => {
    const report = analyseImport(wrap({ ...MCQ, topic: 'Food Safety' }), {
      knownTopics: ['food-safety'],
    })
    expect(report.importedCount).toBe(1)
  })

  it('skips the check when no topic list is supplied', () => {
    // So the parser is usable before the topics have been loaded.
    expect(analyseImport(wrap({ ...MCQ, topic: 'anything' })).importedCount).toBe(1)
  })

  it('collects the topics seen in the file', () => {
    const report = analyseImport(wrap(MCQ, { ...SHORT, topic: 'Storage' }))
    expect(report.topics).toEqual(['food-safety', 'storage'])
  })
})

describe('duplicates within the file', () => {
  it('spots a repeated question and names both rows', () => {
    // A generator repeating itself is a likely and quiet failure at 3,000 rows.
    const report = analyseImport(wrap(MCQ, { ...MCQ, externalId: 'e-0003' }))

    expect(report.importedCount).toBe(1)
    expect(report.duplicates).toHaveLength(1)
    expect(report.duplicates[0]).toMatchObject({ row: 2, firstSeenAtRow: 1 })
  })

  it('matches the database rule: same text at the same level', () => {
    expect(dedupeKey(MCQ as never)).toBe(dedupeKey({ ...MCQ, externalId: 'x' } as never))
  })

  it('does not treat the same text at a different level as a duplicate', () => {
    // (brand, difficulty, text) is the real constraint — the same question may
    // legitimately exist at two levels.
    const report = analyseImport(wrap(MCQ, { ...MCQ, externalId: 'e-9', difficulty: 'hard' }))
    expect(report.importedCount).toBe(2)
    expect(report.duplicates).toHaveLength(0)
  })

  it('ignores case and surrounding space, as the index does', () => {
    const shouty = { ...MCQ, externalId: 'e-9', en: { ...MCQ.en, question: '  FIRST QUESTION ' } }
    const report = analyseImport(wrap(MCQ, shouty))
    expect(report.duplicates).toHaveLength(1)
  })
})

describe('the report', () => {
  it('imports the good rows even when some are bad', () => {
    /*
     * Deliberately permissive. At 3,000 rows, demanding perfection means
     * nothing ever loads; the UI shows the errors and the person decides.
     */
    const report = analyseImport(wrap(MCQ, { difficulty: 'nope' }, SHORT))

    expect(report.importedCount).toBe(2)
    expect(report.rejectedCount).toBe(1)
    expect(isImportable(report)).toBe(true)
  })

  it('is not importable when nothing survived', () => {
    expect(isImportable(analyseImport(wrap({ bad: true })))).toBe(false)
  })

  it('is not importable when the file was fatal', () => {
    expect(isImportable(analyseImport('rubbish'))).toBe(false)
  })

  it('reports the balance across the three levels', () => {
    /*
     * The target is 1,000 per level. A 3,000-row file that turns out to be
     * 1,400 Easy and 600 Hard is worth seeing BEFORE it lands, rather than
     * when a Hard paper cannot be generated.
     */
    const easy = Array.from({ length: 3 }, (_, i) => ({
      ...MCQ,
      externalId: `e-${i}`,
      en: { ...MCQ.en, question: `Easy question ${i}` },
    }))
    const report = analyseImport(wrap(...easy, SHORT))
    const balance = difficultyBalance(report)

    expect(balance.find((b) => b.difficulty === 'easy')?.count).toBe(3)
    expect(balance.find((b) => b.difficulty === 'hard')?.count).toBe(1)
    expect(balance.find((b) => b.difficulty === 'medium')?.count).toBe(0)
  })

  it('counts rows even when every one of them fails', () => {
    const report = analyseImport(wrap({ bad: 1 }, { bad: 2 }))
    expect(report.totalRows).toBe(2)
    expect(report.importedCount).toBe(0)
  })
})

describe('status', () => {
  it('defaults to active, because the dataset is curated before it arrives', () => {
    // Defaulting to draft would import 3,000 unusable questions and require a
    // bulk activation nobody asked for.
    expect(analyseImport(wrap(MCQ)).countsByStatus).toEqual({ draft: 0, active: 1, archived: 0 })
  })

  it('honours an explicit draft', () => {
    const report = analyseImport(wrap({ ...MCQ, status: 'draft' }))
    expect(report.countsByStatus.draft).toBe(1)
  })

  it('rejects an unknown status, categorised as such', () => {
    const report = analyseImport(wrap({ ...MCQ, status: 'published' }))
    expect(report.rejectionsByReason['invalid-status']).toBe(1)
  })

  it('downgrades active to draft when a REQUIRED language is missing', () => {
    /*
     * The row is kept, not lost. The trigger in 0054 would refuse to write it
     * as active, and discarding a perfectly good question over a translation
     * that is coming later would be the wrong trade.
     */
    const report = analyseImport(wrap(MCQ), { requiredLocales: ['en', 'hi', 'gu'] })

    expect(report.importedCount).toBe(1)
    expect(report.countsByStatus).toEqual({ draft: 1, active: 0, archived: 0 })
    expect(report.downgradedToDraftCount).toBe(1)
    expect(report.missingTranslations[0]).toMatchObject({
      row: 1,
      locales: ['hi', 'gu'],
      downgradedToDraft: true,
    })
  })

  it('does not downgrade when only English is required', () => {
    const report = analyseImport(wrap(MCQ), { requiredLocales: ['en'] })
    expect(report.countsByStatus.active).toBe(1)
    expect(report.downgradedToDraftCount).toBe(0)
    // Still reported as missing translations — an advisory, not a problem.
    expect(report.missingTranslations[0].downgradedToDraft).toBe(false)
  })

  it('does not downgrade a row that only asked to be a draft', () => {
    const report = analyseImport(wrap({ ...MCQ, status: 'draft' }), {
      requiredLocales: ['en', 'hi', 'gu'],
    })
    expect(report.downgradedToDraftCount).toBe(0)
  })
})

describe('imported vs updated', () => {
  it('treats everything as new when no existing ids are supplied', () => {
    // Correct for a first import.
    const report = analyseImport(wrap(MCQ, SHORT))
    expect(report.importedCount).toBe(2)
    expect(report.updatedCount).toBe(0)
  })

  it('splits new from existing on externalId', () => {
    /*
     * The whole reason externalId is recommended: a re-import after fixing a
     * typo must UPDATE the question, not create a second one beside it.
     */
    const report = analyseImport(wrap(MCQ, SHORT), { existingExternalIds: ['e-0001'] })

    expect(report.updatedCount).toBe(1)
    expect(report.importedCount).toBe(1)
    expect(report.toUpdate[0].externalId).toBe('e-0001')
    expect(report.toImport[0].externalId).toBe('e-0002')
  })

  it('treats a row with no externalId as new even if its text exists', () => {
    // Nothing to match on. This is why externalId is recommended for a 3,000-
    // row dataset — without it, a correction cannot be recognised as one.
    const { externalId, ...anonymous } = MCQ
    void externalId
    const report = analyseImport(wrap(anonymous), { existingExternalIds: ['e-0001'] })
    expect(report.importedCount).toBe(1)
    expect(report.updatedCount).toBe(0)
  })
})

describe('rejection categories', () => {
  it('groups rejections by cause so one fix can recover most of a file', () => {
    /*
     * "412 rows rejected" plus 412 sentences is a log, not a report. The
     * categories are what tell somebody which ONE thing to change in their
     * generator — at 3,000 rows that is the difference between one more run
     * and a dozen.
     */
    const report = analyseImport(
      wrap(
        { ...MCQ, externalId: 'a', difficulty: 'trivial' },
        { ...MCQ, externalId: 'b', difficulty: 'nightmare' },
        { ...MCQ, externalId: 'c', type: 'essay' },
        { ...MCQ, externalId: 'd', en: { question: 'No options here' } },
      ),
    )

    expect(report.rejectionsByReason['invalid-difficulty']).toBe(2)
    expect(report.rejectionsByReason['invalid-type']).toBe(1)
    expect(report.rejectionsByReason['invalid-option-structure']).toBe(1)
    expect(report.rejectedCount).toBe(4)
  })

  it('counts every reason, including the ones that did not fire', () => {
    // A zero is information: it says that category was checked and was clean.
    const report = analyseImport(wrap(MCQ))
    expect(report.rejectionsByReason['unknown-topic']).toBe(0)
    expect(report.rejectionsByReason.malformed).toBe(0)
  })

  it('categorises a row that is not shaped like a question at all', () => {
    const report = analyseImport(wrap({ nonsense: true }))
    expect(report.rejectionsByReason['invalid-difficulty']).toBe(1)
  })
})

describe('extractRows', () => {
  it('returns rows for each accepted shape', () => {
    expect(extractRows('[]')).toEqual({ rows: [] })
    expect(extractRows('{"questions":[]}')).toEqual({ rows: [] })
  })

  it('returns a fatal message rather than throwing', () => {
    const result = extractRows('{')
    expect('fatal' in result).toBe(true)
  })
})
