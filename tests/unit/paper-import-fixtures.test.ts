import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { detectFormat, parseAnswerKey, parsePaper } from '@/lib/bank/paper/detect'
import { analysePaper, isPaperImportable } from '@/lib/bank/paper/validate'
import { paperBatches, paperCommitRows } from '@/lib/bank/paper/commit'
import { latinWords } from '@/lib/bank/paper/decode'
import type { BankFact } from '@/lib/bank/paper/types'
import type { OptionKey } from '@/lib/bank/vocabulary'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The importer against the REAL 1,030-question Hindi export.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ ALL 1,030, NEVER A SAMPLE.                                                ║
 * ║                                                                           ║
 * ║ A parser test that checks the first three questions passes on a file      ║
 * ║ whose last four hundred are shifted by one cell — which is precisely the  ║
 * ║ failure mode of a grid-based answer key, and the one that reaches a       ║
 * ║ member of staff as a wrong mark. So every assertion here is over the      ║
 * ║ whole set: every id distinct, every option present, every letter checked. ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ SKIPPED WHEN assets/ IS ABSENT, AND THAT IS NOT A LOOPHOLE.               │
 * │                                                                           │
 * │ assets/ holds a 92 MB cookbook and is not committed, so CI has no copy of │
 * │ these files. The behavioural tests in paper-import.test.ts run everywhere │
 * │ and cover every rule; THIS file exists to prove the rules hold against a  │
 * │ document nobody wrote for a test, at full scale.                          │
 * │                                                                           │
 * │ The bank side comes from _aiko-hard.json — the English dataset already    │
 * │ imported — so the answer-letter agreement is checked against the same     │
 * │ source the bank was built from, not against the key itself.               │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */

const PAPER = resolve('assets/AIKO_Hard_Paper_Hindi_2.html')
const KEY = resolve('assets/AIKO_Hard_AnswerKey_Hindi_1.html')
const BANK = resolve('_aiko-hard.json')

const available = existsSync(PAPER) && existsSync(KEY) && existsSync(BANK)
const withFixtures = available ? describe : describe.skip

/** The bank, as resolvePaperTargets() would return it for these ids. */
function bankFacts(): BankFact[] {
  const raw = JSON.parse(readFileSync(BANK, 'utf-8')) as {
    questions: {
      externalId: string
      difficulty: 'easy' | 'medium' | 'hard'
      type: 'mcq' | 'short_answer'
      topic?: string
      correctOption?: OptionKey
    }[]
  }

  return raw.questions.map((question) => ({
    externalId: question.externalId,
    qtype: question.type,
    difficulty: question.difficulty,
    status: 'active' as const,
    correctOption: question.correctOption ?? null,
    topicSlug: question.topic ?? null,
    // English only — this is the state the Hard tier is actually in.
    locales: ['en' as const],
  }))
}

withFixtures('the real Hindi Hard export', () => {
  const paperHtml = available ? readFileSync(PAPER, 'utf-8') : ''
  const keyHtml = available ? readFileSync(KEY, 'utf-8') : ''

  it('is recognised as the paper and the key, respectively', () => {
    expect(detectFormat('AIKO_Hard_Paper_Hindi_2.html', paperHtml)).toEqual({
      format: 'aiko-html',
      role: 'paper',
    })
    expect(detectFormat('AIKO_Hard_AnswerKey_Hindi_1.html', keyHtml)).toEqual({
      format: 'aiko-html',
      role: 'answer-key',
    })
  })

  it('reads every one of the 1,030 blocks, with no id used twice', () => {
    const paper = parsePaper('aiko-html', paperHtml)

    expect(paper.fatal).toBeUndefined()
    expect(paper.questions).toHaveLength(1030)
    expect(new Set(paper.questions.map((q) => q.externalId)).size).toBe(1030)

    // 1,000 multiple choice + 30 short answer, and nothing in between: a block
    // the parser was unsure about would be `null` here and fail this.
    expect(paper.questions.filter((q) => q.detectedType === 'mcq')).toHaveLength(1000)
    expect(paper.questions.filter((q) => q.detectedType === 'short_answer')).toHaveLength(30)
    expect(paper.questions.filter((q) => q.detectedType === null)).toHaveLength(0)

    // Numbered 1..1030 with no repeat and no gap.
    const numbers = paper.questions.map((q) => q.number)
    expect(numbers.filter((n) => n === null)).toHaveLength(0)
    expect(new Set(numbers).size).toBe(1030)
    expect(Math.min(...(numbers as number[]))).toBe(1)
    expect(Math.max(...(numbers as number[]))).toBe(1030)

    // No block carried an issue of any kind.
    expect(paper.questions.flatMap((q) => q.issues)).toEqual([])
  })

  it('carries four non-empty options on every multiple-choice question', () => {
    const paper = parsePaper('aiko-html', paperHtml)
    const mcq = paper.questions.filter((q) => q.detectedType === 'mcq')

    for (const question of mcq) {
      const options = Object.values(question.options)
      expect(options).toHaveLength(4)
      expect(options.every((text) => typeof text === 'string' && text.length > 0)).toBe(true)
    }
    expect(mcq).toHaveLength(1000)
  })

  it('reads 1,030 answer-key entries, 30 of them short answers', () => {
    const key = parseAnswerKey('aiko-html', keyHtml)

    expect(key.fatal).toBeUndefined()
    expect(key.entries).toHaveLength(1030)
    expect(key.entries.filter((e) => e.letter !== null)).toHaveLength(1000)
    expect(key.entries.filter((e) => e.answerText !== null)).toHaveLength(30)
    expect(new Set(key.entries.map((e) => e.externalId)).size).toBe(1030)
    expect(key.entries.flatMap((e) => e.issues)).toEqual([])
  })

  it('preserves the Devanagari exactly — no mojibake, no replacement characters', () => {
    const paper = parsePaper('aiko-html', paperHtml)

    const everything = paper.questions
      .flatMap((q) => [q.stem, ...Object.values(q.options)])
      .join('\n')

    expect(everything).not.toMatch(/�/)
    expect(everything).not.toMatch(/Ã|Â/)
    // The entity the generator escapes every apostrophe with. If decoding
    // regressed, this is what would be printed on an exam paper.
    expect(everything).not.toMatch(/&#x27;|&amp;|&quot;/)
    // And it really is Devanagari, rather than an empty parse that trivially
    // satisfies every assertion above.
    expect(everything).toMatch(/[ऀ-ॿ]/)
    expect(paper.questions.every((q) => /[ऀ-ॿ]/.test(q.stem))).toBe(true)
  })

  it('is fully translated — no residual English in any stem or option', () => {
    const paper = parsePaper('aiko-html', paperHtml)

    const strays = paper.questions.filter(
      (q) =>
        latinWords(q.stem).length > 0 ||
        Object.values(q.options).some((text) => latinWords(text).length > 0),
    )

    // The 17 Aug export was 90% English by this measure and was deliberately
    // held back. This one is clean, and the test says which.
    expect(strays.map((q) => q.externalId)).toEqual([])
  })

  it('validates against the bank as 1,030 updates, 0 errors', () => {
    const report = analysePaper(
      parsePaper('aiko-html', paperHtml),
      parseAnswerKey('aiko-html', keyHtml),
      {
        locale: 'hi',
        facts: bankFacts(),
        duplicateMode: 'update',
        createUnmatched: false,
        createDifficulty: null,
      },
    )

    expect(report.fatal).toBeUndefined()
    expect(report.detected).toBe(1030)
    expect(report.keyEntries).toBe(1030)
    expect(report.matched).toBe(1030)

    expect(report.newCount).toBe(0)
    expect(report.existingCount).toBe(1030)
    expect(report.updateCount).toBe(1030)
    expect(report.createCount).toBe(0)
    expect(report.skipCount).toBe(0)

    expect(report.errorCount).toBe(0)
    expect(report.blockingCount).toBe(0)
    expect(report.rejectedCount).toBe(0)
    expect(report.validCount).toBe(1030)
    expect(report.warningCount).toBe(0)

    expect(report.duplicateIds).toEqual([])
    expect(report.duplicateNumbers).toEqual([])
    expect(report.missingNumbers).toEqual([])
    expect(report.extraKeyIds).toEqual([])

    expect(report.countsByType).toEqual({ mcq: 1000, short_answer: 30 })
    expect(report.countsByDifficulty).toEqual({ easy: 0, medium: 0, hard: 1030 })

    expect(isPaperImportable(report)).toBe(true)
  })

  it("agrees with the bank's answer on all 1,000 multiple-choice questions", () => {
    const facts = new Map(bankFacts().map((fact) => [fact.externalId, fact]))
    const report = analysePaper(
      parsePaper('aiko-html', paperHtml),
      parseAnswerKey('aiko-html', keyHtml),
      {
        locale: 'hi',
        facts: [...facts.values()],
        duplicateMode: 'update',
        createUnmatched: false,
        createDifficulty: null,
      },
    )

    const mcq = report.questions.filter((q) => q.qtype === 'mcq')
    expect(mcq).toHaveLength(1000)

    let agreed = 0
    for (const question of mcq) {
      const bank = facts.get(question.externalId)
      expect(question.correctOption).not.toBeNull()
      if (question.correctOption === bank?.correctOption) agreed += 1
    }
    // Checking that the letter EXISTS would pass on a re-ordered export; this
    // is the check that would have caught the 267/1000 agreement in the first
    // translation export.
    expect(agreed).toBe(1000)

    for (const question of report.questions.filter((q) => q.qtype === 'short_answer')) {
      expect(question.correctOption).toBeNull()
      expect(question.answerText).toBeTruthy()
      expect(question.answerText!.length).toBeLessThanOrEqual(400)
    }
  })

  it('batches into 11 calls covering every question exactly once', () => {
    const report = analysePaper(
      parsePaper('aiko-html', paperHtml),
      parseAnswerKey('aiko-html', keyHtml),
      {
        locale: 'hi',
        facts: bankFacts(),
        duplicateMode: 'update',
        createUnmatched: false,
        createDifficulty: null,
      },
    )

    const rows = paperCommitRows(report)
    expect(rows).toHaveLength(1030)
    expect(rows.every((row) => row.action === 'update')).toBe(true)

    const batches = paperBatches(rows)
    expect(batches).toHaveLength(11)
    expect(batches.reduce((total, batch) => total + batch.length, 0)).toBe(1030)
    expect(new Set(batches.flat().map((row) => row.externalId)).size).toBe(1030)
  })

  it('refuses to create anything from a Hindi file when the bank is empty', () => {
    // The same file against a bank that does not hold these questions. Every
    // row is a blocking error naming its own id, rather than 1,030 silently
    // dropped questions and a cheerful "0 imported".
    const report = analysePaper(
      parsePaper('aiko-html', paperHtml),
      parseAnswerKey('aiko-html', keyHtml),
      {
        locale: 'hi',
        facts: [],
        duplicateMode: 'update',
        createUnmatched: true,
        createDifficulty: 'hard',
      },
    )

    expect(report.errorCount).toBe(1030)
    expect(report.blockingCount).toBe(1030)
    expect(report.errorsByCode['cannot-create-without-english']).toBe(1030)
    expect(isPaperImportable(report)).toBe(false)
  })
})
