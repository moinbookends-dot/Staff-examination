import { describe, it, expect } from 'vitest'
import { blueprintFor, countFor } from '@/lib/papers/blueprint'
import { generatePaper } from '@/lib/papers/generate'
import type { QuestionType } from '@/lib/bank/vocabulary'
import type {
  PaperRepository,
  PaperScope,
  SavePaperInput,
  SavePaperOutcome,
} from '@/lib/papers/repository'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The HARD paper, and specifically that it stays hard.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ WHY A SEPARATE FILE RATHER THAN A THIRD DIFFICULTY IN paper-generator.    ║
 * ║                                                                           ║
 * ║ That suite's fake takes `_scope` and ignores it — deliberately, because   ║
 * ║ what it is proving is the never-twice arithmetic, which does not depend   ║
 * ║ on scope. The consequence is that it CANNOT fail if the difficulty is     ║
 * ║ dropped somewhere between the request and the draw.                       ║
 * ║                                                                           ║
 * ║ That is the failure this file exists for, and it is a quiet one: a Hard   ║
 * ║ paper drawn from the Easy bank has 16 MCQs, 4 short answers, a valid      ║
 * ║ hash, a correct mark total and a header reading "Level: Hard". Every      ║
 * ║ count a person would think to check is right. Only the questions are      ║
 * ║ wrong, and the person best placed to notice is the member of staff        ║
 * ║ sitting an exam that turns out to be easier than the one they were told   ║
 * ║ they were taking.                                                         ║
 * ║                                                                           ║
 * ║ So the fake here RECORDS the scope of every call and the assertions are   ║
 * ║ about propagation, not about counting.                                    ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */

const HARD: PaperScope = {
  companyId: 'company-1',
  brandId: 'brand-1',
  difficulty: 'hard',
  marks: 20,
}

/** Deterministic, so a failure is reproducible rather than occasional. */
function seeded(seed: number): () => number {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648
    return s / 2147483648
  }
}

/**
 * A bank that answers every scope, and remembers which one it was asked for.
 *
 * It does NOT filter by difficulty — filtering would hide the bug, because a
 * repository that received the wrong difficulty would then return an empty
 * pool and the test would fail as a shortfall rather than as what it is.
 */
class ScopeRecordingRepository implements PaperRepository {
  readonly saved: SavePaperInput[] = []
  readonly drawScopes: { difficulty: string; qtype: QuestionType; count: number }[] = []
  readonly countScopes: string[] = []
  private readonly hashes = new Set<string>()

  constructor(
    private readonly mcq: number,
    private readonly short: number,
    private readonly rng: () => number = seeded(7),
  ) {}

  async countPool(scope: PaperScope) {
    this.countScopes.push(scope.difficulty)
    return { mcq: this.mcq, shortAnswer: this.short }
  }

  async drawQuestionIds(scope: PaperScope, qtype: QuestionType, count: number) {
    this.drawScopes.push({ difficulty: scope.difficulty, qtype, count })
    const size = qtype === 'mcq' ? this.mcq : this.short
    // Ids are tagged with the difficulty they were drawn under, so a paper
    // assembled from the wrong bank is visible in the saved rows themselves.
    const all = Array.from({ length: size }, (_, i) => `${scope.difficulty}-${qtype}-${i}`)
    for (let i = all.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.rng() * (i + 1))
      ;[all[i], all[j]] = [all[j], all[i]]
    }
    return all.slice(0, count)
  }

  async countGenerated() {
    return this.saved.length
  }

  async currentEpoch() {
    return 1
  }

  async save(input: SavePaperInput): Promise<SavePaperOutcome> {
    if (this.hashes.has(input.combinationHash)) return { status: 'duplicate' }
    this.hashes.add(input.combinationHash)
    this.saved.push(input)
    return { status: 'saved', paperId: `paper-${this.saved.length}`, paperNo: this.saved.length }
  }
}

describe('a hard paper', () => {
  it('is 16 MCQ + 4 short, the same blueprint every level uses', () => {
    const blueprint = blueprintFor(HARD.marks)

    expect(blueprint.mcqCount).toBe(16)
    expect(blueprint.shortAnswerCount).toBe(4)
    expect(blueprint.mcqCount + blueprint.shortAnswerCount).toBe(20)
    expect(countFor(blueprint, 'mcq')).toBe(16)
    expect(countFor(blueprint, 'short_answer')).toBe(4)
  })

  it('generates from a hard bank', async () => {
    const repo = new ScopeRecordingRepository(1000, 30)
    const result = await generatePaper({ scope: HARD, generatedBy: 'admin-1' }, repo)

    expect(result.status).toBe('generated')
    if (result.status !== 'generated') return

    expect(result.questions).toHaveLength(20)
    expect(result.questions.filter((q) => q.section === 'mcq')).toHaveLength(16)
    expect(result.questions.filter((q) => q.section === 'short_answer')).toHaveLength(4)

    // Continuous 1..20 — the numbers are the answer key's only handle.
    expect(result.questions.map((q) => q.questionNo)).toEqual(
      Array.from({ length: 20 }, (_, i) => i + 1),
    )

    // No question appears twice on one paper.
    expect(new Set(result.questions.map((q) => q.id)).size).toBe(20)
  })

  /**
   * The reason this file exists. Asserted on EVERY call rather than on the
   * request, because the request is trivially correct — it is the propagation
   * through countPool and both draws that could silently widen.
   */
  it('asks the bank for hard questions, and only hard, on every call', async () => {
    const repo = new ScopeRecordingRepository(1000, 30)
    const result = await generatePaper({ scope: HARD, generatedBy: 'admin-1' }, repo)

    expect(repo.countScopes).toEqual(['hard'])
    expect(repo.drawScopes).toEqual([
      { difficulty: 'hard', qtype: 'mcq', count: 16 },
      { difficulty: 'hard', qtype: 'short_answer', count: 4 },
    ])

    // And the paper is built from what those calls returned.
    if (result.status !== 'generated') throw new Error('expected a paper')
    expect(result.questions.every((q) => q.id.startsWith('hard-'))).toBe(true)
  })

  it('records hard on the saved paper', async () => {
    const repo = new ScopeRecordingRepository(1000, 30)
    await generatePaper({ scope: HARD, generatedBy: 'admin-1' }, repo)

    expect(repo.saved).toHaveLength(1)
    expect(repo.saved[0].scope.difficulty).toBe('hard')
    expect(repo.saved[0].blueprint).toEqual({ marks: 20, mcqCount: 16, shortAnswerCount: 4 })
    expect(repo.saved[0].questions).toHaveLength(20)
  })

  /**
   * The state the bank was in before the Hard import: the level exists
   * everywhere in the code and holds nothing.
   *
   * Both shortfalls must be reported, not just the first — somebody about to
   * go and write questions needs the whole list or they make two trips.
   */
  it('reports both shortfalls when the hard bank is empty', async () => {
    const repo = new ScopeRecordingRepository(0, 0)
    const result = await generatePaper({ scope: HARD, generatedBy: 'admin-1' }, repo)

    expect(result.status).toBe('short')
    if (result.status !== 'short') return

    expect(result.shortfalls).toEqual([
      { qtype: 'mcq', needed: 16, available: 0 },
      { qtype: 'short_answer', needed: 4, available: 0 },
    ])
    // Nothing was drawn: the shortfall is decided before any draw is attempted.
    expect(repo.drawScopes).toEqual([])
  })

  /**
   * A bank big enough for MCQs and one short answer short still cannot make a
   * paper, and must say which half is missing rather than reporting both.
   */
  it('names only the type that is actually short', async () => {
    const repo = new ScopeRecordingRepository(1000, 3)
    const result = await generatePaper({ scope: HARD, generatedBy: 'admin-1' }, repo)

    expect(result.status).toBe('short')
    if (result.status !== 'short') return
    expect(result.shortfalls).toEqual([{ qtype: 'short_answer', needed: 4, available: 3 }])
  })

  /**
   * Two hard papers drawn from the same 1,030-question bank must not be the
   * same paper. With C(1000,16) × C(30,4) combinations a collision here would
   * mean the fingerprint is not being computed over the drawn ids at all.
   */
  it('does not draw the same hard paper twice', async () => {
    const repo = new ScopeRecordingRepository(1000, 30)

    const first = await generatePaper({ scope: HARD, generatedBy: 'admin-1' }, repo)
    const second = await generatePaper({ scope: HARD, generatedBy: 'admin-1' }, repo)

    expect(first.status).toBe('generated')
    expect(second.status).toBe('generated')
    expect(repo.saved).toHaveLength(2)
    expect(repo.saved[0].combinationHash).not.toBe(repo.saved[1].combinationHash)
  })
})
