import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect } from 'vitest'
import { analyseImport } from '@/lib/bank/import/analyse'

/**
 * The documented example must always pass the importer unchanged.
 *
 * samples/ is what a person is handed when they ask "what shape does my file
 * need to be?" — an example the importer rejects teaches the wrong contract
 * and burns an afternoon. This test is the lock: edit the sample and the
 * contract together or not at all.
 */
describe('the shipped sample files', () => {
  it('capiche-questions.sample.json imports 3 of 3 with zero errors', () => {
    const raw = readFileSync(resolve('samples/capiche-questions.sample.json'), 'utf8')
    const report = analyseImport(raw, {
      // The slugs the sample uses. Live topic lists come from the database;
      // the sample must stay inside the seeded vocabulary.
      knownTopics: ['key-ingredients', 'cooking-temperature', 'faults-fixes'],
      requiredLocales: ['en'],
    })

    expect(report.fatal).toBeUndefined()
    expect(report.rejected).toEqual([])
    expect(report.duplicateCount).toBe(0)
    expect(report.importedCount).toBe(3)

    // Both question types are represented and recognised.
    expect(report.countsByType.mcq).toBe(2)
    expect(report.countsByType.short_answer).toBe(1)

    // The wrong-brand guard sees the declared brand.
    expect(report.declaredBrand).toBe('capiche')
  })

  it('re-analysing against its own ids reads as an update, not a duplicate', () => {
    const raw = readFileSync(resolve('samples/capiche-questions.sample.json'), 'utf8')
    const ids = ['capiche-easy-0001', 'capiche-medium-0001', 'capiche-hard-0001']
    const report = analyseImport(raw, { existingExternalIds: ids, requiredLocales: ['en'] })
    expect(report.updatedCount).toBe(3)
    expect(report.importedCount).toBe(0)
    expect(report.rejectedCount).toBe(0)
  })
})
