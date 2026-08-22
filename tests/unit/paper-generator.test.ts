import { describe, it, expect } from 'vitest'
import {
  blueprintFor,
  countFor,
  isValidBlueprint,
  isValidPaperSize,
} from '@/lib/papers/blueprint'
import {
  COMBINATION_CAP,
  countCombinations,
  isEffectivelyUnlimited,
  isExhausted,
  totalPossiblePapers,
} from '@/lib/papers/combinations'
import { combinationHash, combinationHashBuffer } from '@/lib/papers/paper-hash'
import { generatePaper, placeQuestions, shuffle } from '@/lib/papers/generate'
import type { QuestionType } from '@/lib/bank/vocabulary'
import type {
  PaperRepository,
  PaperScope,
  SavePaperInput,
  SavePaperOutcome,
} from '@/lib/papers/repository'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Paper generation, tested end to end without a database.
 *
 * Every dependency is PaperRepository, so the fake below stands in for the
 * whole question bank. That is the point of the interface: the never-twice
 * rule, the exhaustion arithmetic and the retry loop are all provable now,
 * and the same tests keep running unchanged once the real adapter exists.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const SCOPE: PaperScope = {
  companyId: 'company-1',
  brandId: 'brand-1',
  difficulty: 'medium',
  marks: 20,
}

/**
 * An in-memory bank.
 *
 * Ids are synthetic and carry no content — the generator never reads question
 * text, so there is nothing here to fabricate.
 */
class FakeRepository implements PaperRepository {
  saved: SavePaperInput[] = []
  private readonly seen = new Set<string>()
  drawCalls = 0

  constructor(
    private readonly mcqIds: string[],
    private readonly shortIds: string[],
    private readonly rng: () => number = Math.random,
    private epoch = 1,
  ) {}

  async countPool() {
    return { mcq: this.mcqIds.length, shortAnswer: this.shortIds.length }
  }

  async drawQuestionIds(_scope: PaperScope, qtype: QuestionType, count: number) {
    this.drawCalls += 1
    const pool = qtype === 'mcq' ? this.mcqIds : this.shortIds
    return shuffle(pool, this.rng).slice(0, count)
  }

  async countGenerated() {
    return this.saved.length
  }

  async currentEpoch() {
    return this.epoch
  }

  /** Mirrors the unique index in 0056: the hash decides, not a prior SELECT. */
  async save(input: SavePaperInput): Promise<SavePaperOutcome> {
    if (this.seen.has(input.combinationHash)) return { status: 'duplicate' }
    this.seen.add(input.combinationHash)
    this.saved.push(input)
    return { status: 'saved', paperId: `paper-${this.saved.length}`, paperNo: this.saved.length }
  }

  /** A reset: history is kept, the epoch moves, exhaustion starts again. */
  resetEpoch() {
    this.epoch += 1
    this.seen.clear()
    this.saved = []
  }
}

const ids = (prefix: string, n: number) =>
  Array.from({ length: n }, (_, i) => `${prefix}-${String(i).padStart(4, '0')}`)

/** Deterministic RNG so shuffles are repeatable. Mulberry32. */
function seeded(seed: number): () => number {
  let a = seed
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ─────────────────────────────────────────────────────────────────────────────

describe('blueprint', () => {
  it('derives the two shipped sizes from the ratio alone', () => {
    expect(blueprintFor(20)).toEqual({ marks: 20, mcqCount: 16, shortAnswerCount: 4 })
    expect(blueprintFor(50)).toEqual({ marks: 50, mcqCount: 40, shortAnswerCount: 10 })
  })

  it('holds 80/20 for any valid size, not just the two', () => {
    for (const marks of [5, 10, 25, 30, 100, 200]) {
      const b = blueprintFor(marks)
      expect(b.mcqCount + b.shortAnswerCount).toBe(marks)
      expect(b.mcqCount / marks).toBeCloseTo(0.8, 10)
      expect(b.shortAnswerCount / marks).toBeCloseTo(0.2, 10)
    }
  })

  it('refuses a size the ratio cannot split into whole questions', () => {
    // 22 marks would be 17.6 + 4.4. Rounding would produce a paper whose
    // ratio is not 80/20 while appearing to obey the rule.
    for (const marks of [22, 7, 13, 0, -5, 20.5]) {
      expect(isValidPaperSize(marks)).toBe(false)
      expect(() => blueprintFor(marks)).toThrow()
    }
  })

  it('rejects a blueprint that sums correctly but breaks the ratio', () => {
    // The direction a naive check misses: 10 + 10 = 20 and is not the product.
    expect(isValidBlueprint({ marks: 20, mcqCount: 10, shortAnswerCount: 10 })).toBe(false)
    expect(isValidBlueprint({ marks: 20, mcqCount: 16, shortAnswerCount: 4 })).toBe(true)
  })

  it('rejects a blueprint at the right ratio that does not sum', () => {
    expect(isValidBlueprint({ marks: 20, mcqCount: 16, shortAnswerCount: 5 })).toBe(false)
  })

  it('reports the count for each type', () => {
    const b = blueprintFor(50)
    expect(countFor(b, 'mcq')).toBe(40)
    expect(countFor(b, 'short_answer')).toBe(10)
  })
})

describe('combinations', () => {
  it('computes small cases exactly', () => {
    expect(countCombinations(5, 2)).toBe(10)
    expect(countCombinations(52, 5)).toBe(2598960)
    expect(countCombinations(20, 10)).toBe(184756)
  })

  it('returns 1 at the floor — choosing everything', () => {
    // The case the whole exhaustion feature turns on: 16 MCQs choose 16.
    expect(countCombinations(16, 16)).toBe(1)
    expect(countCombinations(4, 4)).toBe(1)
    expect(countCombinations(9, 0)).toBe(1)
  })

  it('returns 0 when asked for more than exists', () => {
    expect(countCombinations(12, 16)).toBe(0)
  })

  it('caps rather than overflowing on the real bank size', () => {
    // C(1000,16) ≈ 4.8e34. Computing it exactly would lose precision long
    // before it finished, and no caller needs the digits.
    const n = countCombinations(1000, 16)
    expect(n).toBe(COMBINATION_CAP)
    expect(isEffectivelyUnlimited(n)).toBe(true)
  })

  it('multiplies the two sections', () => {
    const blueprint = blueprintFor(20)
    // C(16,16) × C(4,4) = 1 — exactly one possible paper.
    expect(totalPossiblePapers({ mcq: 16, shortAnswer: 4 }, blueprint)).toBe(1)
    // C(17,16) × C(4,4) = 17.
    expect(totalPossiblePapers({ mcq: 17, shortAnswer: 4 }, blueprint)).toBe(17)
    // C(17,16) × C(5,4) = 17 × 5 = 85.
    expect(totalPossiblePapers({ mcq: 17, shortAnswer: 5 }, blueprint)).toBe(85)
  })

  it('reports zero when either section is impossible', () => {
    const blueprint = blueprintFor(20)
    expect(totalPossiblePapers({ mcq: 10, shortAnswer: 4 }, blueprint)).toBe(0)
    expect(totalPossiblePapers({ mcq: 16, shortAnswer: 2 }, blueprint)).toBe(0)
  })

  it('treats an unreachable total as never exhausted', () => {
    expect(isExhausted(1_000_000, COMBINATION_CAP)).toBe(false)
  })

  it('treats history exceeding the pool as exhausted', () => {
    /*
     * Happens the moment a question is archived after papers were drawn from a
     * larger pool. `===` would report "not exhausted" forever and the retry
     * loop would spin against a set it can never extend.
     */
    expect(isExhausted(20, 17)).toBe(true)
  })
})

describe('combination hash', () => {
  it('is independent of order — a set, not a sequence', () => {
    /*
     * The single most important property here. Hashing in draw order would
     * make the never-twice rule almost useless: 20! ≈ 2.4e18 orderings of
     * every combination, so the same twenty questions could be reissued
     * forever without ever colliding, and it would look like it was working.
     */
    const a = combinationHash(['q3', 'q1', 'q2'])
    const b = combinationHash(['q1', 'q2', 'q3'])
    const c = combinationHash(['q2', 'q3', 'q1'])
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('differs for a different set', () => {
    expect(combinationHash(['q1', 'q2'])).not.toBe(combinationHash(['q1', 'q3']))
  })

  it('is 32 bytes, matching the bytea column', () => {
    expect(combinationHashBuffer(['q1', 'q2'])).toHaveLength(32)
    expect(combinationHash(['q1'])).toMatch(/^[0-9a-f]{64}$/)
  })

  it('refuses a repeated id rather than collapsing it', () => {
    // De-duplicating would hash a 19-question paper as though it had 20.
    expect(() => combinationHash(['q1', 'q2', 'q1'])).toThrow(/twice/i)
  })

  it('refuses an empty paper', () => {
    expect(() => combinationHash([])).toThrow()
  })
})

describe('placement', () => {
  it('puts MCQs first, then short answers, numbered continuously', () => {
    const placed = placeQuestions(['m1', 'm2', 'm3'], ['s1', 's2'], seeded(1))

    expect(placed.map((q) => q.questionNo)).toEqual([1, 2, 3, 4, 5])
    expect(placed.slice(0, 3).every((q) => q.section === 'mcq')).toBe(true)
    expect(placed.slice(3).every((q) => q.section === 'short_answer')).toBe(true)
  })

  it('does not interleave the two sections', () => {
    const placed = placeQuestions(ids('m', 16), ids('s', 4), seeded(7))
    const firstShort = placed.findIndex((q) => q.section === 'short_answer')
    expect(placed.slice(firstShort).every((q) => q.section === 'short_answer')).toBe(true)
  })

  it('keeps every drawn question exactly once', () => {
    const placed = placeQuestions(ids('m', 16), ids('s', 4), seeded(3))
    expect(new Set(placed.map((q) => q.id)).size).toBe(20)
  })

  it('actually shuffles', () => {
    // Asserted as "not the input order" rather than against a fixed expected
    // order, which would pin the algorithm rather than the property.
    const input = ids('m', 30)
    const out = placeQuestions(input, [], seeded(42)).map((q) => q.id)
    expect(out).not.toEqual(input)
    expect([...out].sort()).toEqual([...input].sort())
  })

  it('does not mutate its input', () => {
    const input = ids('m', 10)
    const copy = [...input]
    shuffle(input, seeded(5))
    expect(input).toEqual(copy)
  })
})

describe('generatePaper', () => {
  it('generates a full paper from a healthy bank', async () => {
    const repo = new FakeRepository(ids('m', 500), ids('s', 200), seeded(1))
    const result = await generatePaper({ scope: SCOPE, generatedBy: 'user-1' }, repo, {
      random: seeded(2),
    })

    expect(result.status).toBe('generated')
    if (result.status !== 'generated') return

    expect(result.questions).toHaveLength(20)
    expect(result.questions.filter((q) => q.section === 'mcq')).toHaveLength(16)
    expect(result.questions.filter((q) => q.section === 'short_answer')).toHaveLength(4)
    expect(result.paperNo).toBe(1)
  })

  it('is always exactly 80/20', async () => {
    const repo = new FakeRepository(ids('m', 500), ids('s', 200), seeded(9))
    for (const marks of [20, 50]) {
      const result = await generatePaper(
        { scope: { ...SCOPE, marks }, generatedBy: 'user-1' },
        repo,
        { random: seeded(marks) },
      )
      expect(result.status).toBe('generated')
      if (result.status !== 'generated') continue

      const mcq = result.questions.filter((q) => q.section === 'mcq').length
      expect(mcq / marks).toBeCloseTo(0.8, 10)
    }
  })

  // ── The shortfall path ────────────────────────────────────────────────────

  it('reports a shortfall naming the pool and the gap', async () => {
    const repo = new FakeRepository(ids('m', 12), ids('s', 4))
    const result = await generatePaper({ scope: SCOPE, generatedBy: 'user-1' }, repo)

    expect(result.status).toBe('short')
    if (result.status !== 'short') return

    expect(result.shortfalls).toEqual([{ qtype: 'mcq', needed: 16, available: 12 }])
  })

  it('reports BOTH shortfalls, not just the first', async () => {
    // An Editor about to go and write questions needs the whole list, or they
    // make two trips.
    const repo = new FakeRepository(ids('m', 3), ids('s', 1))
    const result = await generatePaper({ scope: SCOPE, generatedBy: 'user-1' }, repo)

    expect(result.status).toBe('short')
    if (result.status !== 'short') return
    expect(result.shortfalls).toHaveLength(2)
  })

  it('prefers shortfall over exhaustion when the bank is too small', async () => {
    /*
     * Ordering matters. With 12 MCQs, C(12,16) is 0, so "every possible paper
     * has been generated" is technically true and completely useless. The
     * message must name the fixable thing.
     */
    const repo = new FakeRepository(ids('m', 12), ids('s', 4))
    const result = await generatePaper({ scope: SCOPE, generatedBy: 'user-1' }, repo)
    expect(result.status).toBe('short')
  })

  it('never saves a paper when it reports a shortfall', async () => {
    const repo = new FakeRepository(ids('m', 12), ids('s', 4))
    await generatePaper({ scope: SCOPE, generatedBy: 'user-1' }, repo)
    expect(repo.saved).toHaveLength(0)
  })

  // ── The floor: exhaustion, both directions ────────────────────────────────

  it('exhausts after exactly one paper when only one is possible', async () => {
    /*
     * ╔═══════════════════════════════════════════════════════════════════════╗
     * ║ THE CHEAPEST PROOF THAT BOTH ENDS OF THE RULE WORK.                    ║
     * ║                                                                       ║
     * ║ 16 MCQs and 4 short answers: C(16,16) × C(4,4) = 1. There is exactly   ║
     * ║ one possible paper. The first generate must succeed and the second     ║
     * ║ must say so immediately — not retry forty times, not fail, not issue   ║
     * ║ the same paper again.                                                  ║
     * ║                                                                       ║
     * ║ This is the state a real bank is in on the first day of question       ║
     * ║ entry, so it is not a contrived edge case.                             ║
     * ╚═══════════════════════════════════════════════════════════════════════╝
     */
    const repo = new FakeRepository(ids('m', 16), ids('s', 4), seeded(1))

    const first = await generatePaper({ scope: SCOPE, generatedBy: 'user-1' }, repo, {
      random: seeded(1),
    })
    expect(first.status).toBe('generated')

    const second = await generatePaper({ scope: SCOPE, generatedBy: 'user-1' }, repo, {
      random: seeded(2),
    })
    expect(second.status).toBe('exhausted')
    if (second.status !== 'exhausted') return
    expect(second.totalCombinations).toBe(1)
    expect(second.generated).toBe(1)

    // And nothing was written the second time.
    expect(repo.saved).toHaveLength(1)
  })

  it('never issues the same combination twice across many draws', async () => {
    /*
     * 17 MCQs choosing 16 and 5 short choosing 4 → C(17,16) × C(5,4) = 85
     * possible papers. Draw far more times than that and assert every SAVED
     * paper is unique — the duplicates are what the retry loop is absorbing.
     */
    const repo = new FakeRepository(ids('m', 17), ids('s', 5), seeded(11))

    for (let i = 0; i < 60; i += 1) {
      await generatePaper({ scope: SCOPE, generatedBy: 'user-1' }, repo, { random: seeded(i) })
    }

    const hashes = repo.saved.map((s) => s.combinationHash)
    expect(new Set(hashes).size).toBe(hashes.length)
    expect(hashes.length).toBeGreaterThan(1)
    expect(hashes.length).toBeLessThanOrEqual(85)
  })

  it('reports exhausted rather than looping forever when draws keep colliding', async () => {
    const repo = new FakeRepository(ids('m', 16), ids('s', 4), seeded(4))
    await generatePaper({ scope: SCOPE, generatedBy: 'user-1' }, repo, { random: seeded(1) })

    // maxAttempts of 3 with only one possible paper: every draw collides.
    const result = await generatePaper({ scope: SCOPE, generatedBy: 'user-1' }, repo, {
      random: seeded(2),
      maxAttempts: 3,
    })
    expect(result.status).toBe('exhausted')
  })

  // ── Reset ─────────────────────────────────────────────────────────────────

  it('allows the same paper again after the epoch is raised', async () => {
    /*
     * The other half of the exhaustion story. A reset does not delete history —
     * it moves the epoch, and the uniqueness rule is scoped to it. This is the
     * safety valve for a bank so thin it has locked up during rollout.
     */
    const repo = new FakeRepository(ids('m', 16), ids('s', 4), seeded(1))

    await generatePaper({ scope: SCOPE, generatedBy: 'user-1' }, repo, { random: seeded(1) })
    expect((await generatePaper({ scope: SCOPE, generatedBy: 'user-1' }, repo)).status).toBe(
      'exhausted',
    )

    repo.resetEpoch()

    const after = await generatePaper({ scope: SCOPE, generatedBy: 'user-1' }, repo, {
      random: seeded(3),
    })
    expect(after.status).toBe('generated')
  })

  // ── The pool shrinking mid-generation ─────────────────────────────────────

  it('refuses rather than issuing a short paper when the pool shrinks mid-draw', async () => {
    /*
     * An Editor archiving a question while a chef generates is entirely
     * ordinary. Trusting the count taken moments earlier would produce a
     * 19-question paper labelled 20 marks — worse than refusing.
     */
    class ShrinkingRepository extends FakeRepository {
      override async drawQuestionIds(scope: PaperScope, qtype: QuestionType, count: number) {
        const drawn = await super.drawQuestionIds(scope, qtype, count)
        return qtype === 'mcq' ? drawn.slice(0, count - 1) : drawn
      }
    }

    const repo = new ShrinkingRepository(ids('m', 500), ids('s', 200), seeded(1))
    const result = await generatePaper({ scope: SCOPE, generatedBy: 'user-1' }, repo)

    expect(result.status).toBe('short')
    expect(repo.saved).toHaveLength(0)
  })

  // ── Bad configuration ─────────────────────────────────────────────────────

  it('fails cleanly on a paper size the ratio cannot split', async () => {
    const repo = new FakeRepository(ids('m', 500), ids('s', 200))
    const result = await generatePaper(
      { scope: { ...SCOPE, marks: 22 }, generatedBy: 'user-1' },
      repo,
    )

    expect(result.status).toBe('failed')
    if (result.status !== 'failed') return
    expect(result.message).toMatch(/multiple of 5/)
  })

  it('reports whether the total is a real number or effectively unlimited', async () => {
    const big = new FakeRepository(ids('m', 1000), ids('s', 1000), seeded(1))
    const result = await generatePaper({ scope: SCOPE, generatedBy: 'user-1' }, big, {
      random: seeded(1),
    })

    expect(result.status).toBe('generated')
    if (result.status !== 'generated') return
    // At the target bank size there are ~2e45 possible papers, so the UI must
    // say "effectively unlimited" rather than print a capped number as fact.
    expect(result.unlimited).toBe(true)
  })
})
