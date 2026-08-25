import { describe, it, expect } from 'vitest'
import { buildLevels, type PoolCountRow } from '@/lib/papers/availability-levels'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Availability reports the bank, not a memory of it.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE FAILURE THIS GUARDS AGAINST is a screen that says 1,030 Medium        ║
 * ║ questions are available when not one has been imported. A chef would      ║
 * ║ build a paper against that number and generation would then fail, or      ║
 * ║ worse, quietly return fewer questions than were asked for.                ║
 * ║                                                                           ║
 * ║ Every figure must trace to a row the database returned. A difficulty      ║
 * ║ with no rows is ZERO — never omitted, never inherited from the level      ║
 * ║ above, never a constant.                                                  ║
 * ║                                                                           ║
 * ║ The counts here mirror the real bank at the time of writing: Aiko carries ║
 * ║ Easy, Medium and Hard; Capiche carries Easy alone. Both shapes are        ║
 * ║ exercised because the second is the one that regressed.                   ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */

const SIZES = [20, 50] as const

/** What bank_pool_counts returns for a brand carrying only Easy — Capiche. */
const easyOnly: PoolCountRow[] = [
  { difficulty: 'easy', qtype: 'mcq', n: 800 },
  { difficulty: 'easy', qtype: 'short_answer', n: 200 },
]

/** A brand carrying all three levels — Aiko. */
const allThree: PoolCountRow[] = [
  { difficulty: 'easy', qtype: 'mcq', n: 818 },
  { difficulty: 'easy', qtype: 'short_answer', n: 205 },
  { difficulty: 'medium', qtype: 'mcq', n: 824 },
  { difficulty: 'medium', qtype: 'short_answer', n: 206 },
  { difficulty: 'hard', qtype: 'mcq', n: 824 },
  { difficulty: 'hard', qtype: 'short_answer', n: 206 },
]

const levelFor = (rows: PoolCountRow[], difficulty: string) =>
  buildLevels(rows, SIZES).find((l) => l.difficulty === difficulty)!

describe('a brand with only Easy imported', () => {
  it('reports Easy from the rows it was given', () => {
    const easy = levelFor(easyOnly, 'easy')
    expect(easy.pool).toEqual({ mcq: 800, shortAnswer: 200 })
  })

  it('reports Medium as exactly zero, not as a missing level', () => {
    const medium = levelFor(easyOnly, 'medium')
    expect(medium.pool).toEqual({ mcq: 0, shortAnswer: 0 })
  })

  it('reports Hard as exactly zero', () => {
    const hard = levelFor(easyOnly, 'hard')
    expect(hard.pool).toEqual({ mcq: 0, shortAnswer: 0 })
  })

  it('does not carry Easy’s count down into the empty levels', () => {
    // The specific bug: 1,030 appearing under Medium and Hard because they
    // inherited the level above rather than being counted.
    const levels = buildLevels(easyOnly, SIZES)
    const easy = levels.find((l) => l.difficulty === 'easy')!
    for (const other of levels.filter((l) => l.difficulty !== 'easy')) {
      expect(other.pool.mcq).not.toBe(easy.pool.mcq)
      expect(other.pool.mcq).toBe(0)
    }
  })

  it('offers no possible paper at a level with no questions', () => {
    // Availability and feasibility have to agree: zero questions cannot make
    // a paper, so the combination count must be zero too.
    const medium = levelFor(easyOnly, 'medium')
    for (const size of SIZES) expect(medium.combinationsBySize[size]).toBe(0)
  })
})

describe('a brand with all three levels imported', () => {
  it('reports each level from its own rows', () => {
    expect(levelFor(allThree, 'easy').pool).toEqual({ mcq: 818, shortAnswer: 205 })
    expect(levelFor(allThree, 'medium').pool).toEqual({ mcq: 824, shortAnswer: 206 })
    expect(levelFor(allThree, 'hard').pool).toEqual({ mcq: 824, shortAnswer: 206 })
  })

  it('offers papers at every level that has questions', () => {
    for (const difficulty of ['easy', 'medium', 'hard']) {
      expect(levelFor(allThree, difficulty).combinationsBySize[20]).toBeGreaterThan(0)
    }
  })
})

describe('the shape of the result', () => {
  it('always returns all three levels, in order, whatever the rows say', () => {
    // The panel renders three rows. A missing level would drop one silently.
    expect(buildLevels([], SIZES).map((l) => l.difficulty)).toEqual(['easy', 'medium', 'hard'])
    expect(buildLevels(easyOnly, SIZES).map((l) => l.difficulty)).toEqual([
      'easy',
      'medium',
      'hard',
    ])
  })

  it('reports zero everywhere when the bank is empty', () => {
    for (const level of buildLevels([], SIZES)) {
      expect(level.pool).toEqual({ mcq: 0, shortAnswer: 0 })
      for (const size of SIZES) expect(level.combinationsBySize[size]).toBe(0)
    }
  })

  it('counts one question type without inventing the other', () => {
    // A level holding MCQs but no short answers must report shortAnswer: 0,
    // not mirror the MCQ figure.
    const mcqOnly: PoolCountRow[] = [{ difficulty: 'hard', qtype: 'mcq', n: 40 }]
    expect(levelFor(mcqOnly, 'hard').pool).toEqual({ mcq: 40, shortAnswer: 0 })
  })

  it('gives a combination entry for every size it was asked about', () => {
    const level = levelFor(allThree, 'easy')
    expect(Object.keys(level.combinationsBySize).map(Number).sort((a, b) => a - b)).toEqual([
      ...SIZES,
    ])
  })

  it('ignores a difficulty it does not recognise rather than rendering it', () => {
    /*
     * Defence against a future difficulty added in SQL but not in the app: it
     * must not appear on a screen that has no design for it. The three known
     * levels still report correctly around it.
     */
    const withStranger = [
      ...easyOnly,
      { difficulty: 'expert', qtype: 'mcq', n: 99 },
    ] as unknown as PoolCountRow[]
    const levels = buildLevels(withStranger, SIZES)
    expect(levels.map((l) => l.difficulty)).toEqual(['easy', 'medium', 'hard'])
    expect(levels.find((l) => l.difficulty === 'easy')!.pool.mcq).toBe(800)
  })
})
