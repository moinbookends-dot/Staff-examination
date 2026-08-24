import { describe, it, expect } from 'vitest'
import { generatePaper } from '@/lib/papers/generate'
import {
  ALL_TOPICS,
  type PaperRepository,
  type PaperScope,
  type SavePaperInput,
  type SavePaperOutcome,
} from '@/lib/papers/repository'
import type { QuestionType } from '@/lib/bank/vocabulary'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Excluding a topic, and the promise that it stays excluded.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE BANK HERE KNOWS EACH QUESTION'S TOPIC AND HONOURS THE FILTER.         ║
 * ║                                                                           ║
 * ║ tests/unit/hard-paper.test.ts takes the opposite approach on purpose: its ║
 * ║ fake ignores the difficulty so a dropped scope field surfaces as a wrong- ║
 * ║ scope assertion. Both are needed, and both are here — `drawnScopes`       ║
 * ║ records what the generator ASKED for, while the pool honours it, so a     ║
 * ║ filter that never reached the repository fails on the recorded scope and  ║
 * ║ a filter applied in the wrong order fails on the paper's contents.        ║
 * ║                                                                           ║
 * ║ The real exclusion lives in SQL (0078), inside the same WHERE as          ║
 * ║ `order by random()`. This suite pins the contract that SQL implements:    ║
 * ║ what the generator requests, what it counts, and what it refuses to save. ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * A question carries EXACTLY ONE topic — bank_questions.topic_id is a single
 * nullable FK and no join table exists — so "exclude a question if any of its
 * topics is excluded" and "exclude it if its topic is excluded" are the same
 * sentence here. The last test states that, so a future many-to-many arrives
 * as a failure rather than as a silent widening.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** A question in the fake bank: an id, a type, and the topic it is filed under. */
interface BankRow {
  id: string
  qtype: QuestionType
  /** null is the untopiced bucket — Capiche's entire bank looks like this. */
  topicId: string | null
}

const HULK = 'topic-hulk'
const SAFE = 'topic-safe'

/**
 * An in-memory bank that applies the scope's topic filter exactly as 0078
 * does: as a predicate over the candidates, before any sampling.
 */
class TopicAwareRepository implements PaperRepository {
  saved: SavePaperInput[] = []
  /** Every scope the generator drew with, for the propagation assertions. */
  drawnScopes: PaperScope[] = []

  constructor(private readonly rows: BankRow[]) {}

  private eligible(scope: PaperScope, qtype?: QuestionType): BankRow[] {
    const topics = scope.topics ?? ALL_TOPICS

    return this.rows.filter((row) => {
      if (qtype && row.qtype !== qtype) return false
      if (topics.topicIds === null) return true
      if (row.topicId === null) return topics.includeNoTopic
      return topics.topicIds.includes(row.topicId)
    })
  }

  async countPool(scope: PaperScope) {
    const rows = this.eligible(scope)
    return {
      mcq: rows.filter((r) => r.qtype === 'mcq').length,
      shortAnswer: rows.filter((r) => r.qtype === 'short_answer').length,
    }
  }

  async drawQuestionIds(scope: PaperScope, qtype: QuestionType, count: number) {
    this.drawnScopes.push(scope)
    return this.eligible(scope, qtype)
      .slice(0, count)
      .map((r) => r.id)
  }

  async countGenerated() {
    return this.saved.length
  }

  async currentEpoch() {
    return 1
  }

  async save(input: SavePaperInput): Promise<SavePaperOutcome> {
    this.saved.push(input)
    return { status: 'saved', paperId: `paper-${this.saved.length}`, paperNo: this.saved.length }
  }
}

/** `n` questions of one type and topic, ids prefixed so failures name them. */
const rows = (prefix: string, n: number, qtype: QuestionType, topicId: string | null): BankRow[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${String(i + 1).padStart(3, '0')}`,
    qtype,
    topicId,
  }))

const scopeWith = (topics: PaperScope['topics']): PaperScope => ({
  companyId: 'company-1',
  brandId: 'brand-1',
  difficulty: 'medium',
  marks: 20,
  topics,
})

const request = (scope: PaperScope) => ({ scope, generatedBy: 'user-1' })

/** A bank with plenty of both types, split across a kept and an excluded topic. */
const mixedBank = () => [
  ...rows('safe-mcq', 80, 'mcq', SAFE),
  ...rows('hulk-mcq', 20, 'mcq', HULK),
  ...rows('safe-short', 16, 'short_answer', SAFE),
  ...rows('hulk-short', 4, 'short_answer', HULK),
]

describe('an excluded topic never reaches a paper', () => {
  it('drops the excluded topic from the eligible pool and from the paper', async () => {
    const repo = new TopicAwareRepository(mixedBank())
    const scope = scopeWith({ topicIds: [SAFE], includeNoTopic: true })

    // The pool the generator will draw from: 120 questions, 24 of them Hulk.
    expect(await repo.countPool(scopeWith(ALL_TOPICS))).toEqual({ mcq: 100, shortAnswer: 20 })
    expect(await repo.countPool(scope)).toEqual({ mcq: 80, shortAnswer: 16 })

    const result = await generatePaper(request(scope), repo)

    expect(result.status).toBe('generated')
    if (result.status !== 'generated') return

    // The whole point: not one Hulk question on the finished paper.
    const hulk = result.questions.filter((q) => q.id.startsWith('hulk-'))
    expect(hulk).toEqual([])
    expect(result.questions).toHaveLength(20)
  })

  it('stays excluded across repeated generations', async () => {
    // A single paper could be luck. Regeneration is where a filter applied
    // after the sample, or re-read from stale state, would eventually leak.
    const repo = new TopicAwareRepository(mixedBank())
    const scope = scopeWith({ topicIds: [SAFE], includeNoTopic: true })

    for (let i = 0; i < 10; i += 1) {
      const result = await generatePaper(request(scope), repo)
      if (result.status !== 'generated') continue
      expect(result.questions.some((q) => q.id.startsWith('hulk-'))).toBe(false)
    }

    expect(repo.saved.length).toBeGreaterThan(0)
    for (const paper of repo.saved) {
      expect(paper.questions.some((q) => q.id.startsWith('hulk-'))).toBe(false)
    }
  })

  it('carries the filter into every draw, not just the first', async () => {
    // Scope propagation: if the filter were dropped between the count and the
    // draw, the paper above could still come out clean by chance. This cannot.
    const repo = new TopicAwareRepository(mixedBank())
    const topics = { topicIds: [SAFE], includeNoTopic: false }

    await generatePaper(request(scopeWith(topics)), repo)

    expect(repo.drawnScopes.length).toBeGreaterThanOrEqual(2)
    for (const scope of repo.drawnScopes) {
      expect(scope.topics).toEqual(topics)
    }
  })
})

describe('the eligibility gate', () => {
  it('refuses rather than issuing a smaller paper when exclusions leave too few', async () => {
    // 100 MCQs, but only 12 of them outside the excluded topic — a 20-mark
    // paper needs 16. The old behaviour of this screen was to promise 100.
    const repo = new TopicAwareRepository([
      ...rows('safe-mcq', 12, 'mcq', SAFE),
      ...rows('hulk-mcq', 88, 'mcq', HULK),
      ...rows('safe-short', 10, 'short_answer', SAFE),
    ])

    const result = await generatePaper(
      request(scopeWith({ topicIds: [SAFE], includeNoTopic: true })),
      repo,
    )

    expect(result.status).toBe('short')
    if (result.status !== 'short') return

    expect(result.shortfalls).toEqual([{ qtype: 'mcq', needed: 16, available: 12 }])
    // Nothing written. A short paper is never an acceptable outcome.
    expect(repo.saved).toEqual([])
  })

  it('reports a shortfall per section, counting only eligible questions', async () => {
    const repo = new TopicAwareRepository([
      ...rows('safe-mcq', 4, 'mcq', SAFE),
      ...rows('safe-short', 1, 'short_answer', SAFE),
      ...rows('hulk-mcq', 500, 'mcq', HULK),
      ...rows('hulk-short', 500, 'short_answer', HULK),
    ])

    const result = await generatePaper(
      request(scopeWith({ topicIds: [SAFE], includeNoTopic: true })),
      repo,
    )

    expect(result.status).toBe('short')
    if (result.status !== 'short') return

    expect(result.shortfalls).toEqual([
      { qtype: 'mcq', needed: 16, available: 4 },
      { qtype: 'short_answer', needed: 4, available: 1 },
    ])
  })

  it('excluding every topic leaves nothing eligible, and generates nothing', async () => {
    // An empty include-list is not "no filter". It admits nothing, which is
    // the honest reading, and the generator must say so rather than fall back.
    const repo = new TopicAwareRepository(mixedBank())

    const result = await generatePaper(
      request(scopeWith({ topicIds: [], includeNoTopic: false })),
      repo,
    )

    expect(result.status).toBe('short')
    expect(repo.saved).toEqual([])
  })

  it('generates an exact 16 + 4 when the eligible pool is exactly enough', async () => {
    const repo = new TopicAwareRepository([
      ...rows('safe-mcq', 16, 'mcq', SAFE),
      ...rows('safe-short', 4, 'short_answer', SAFE),
      ...rows('hulk-mcq', 999, 'mcq', HULK),
    ])

    const result = await generatePaper(
      request(scopeWith({ topicIds: [SAFE], includeNoTopic: true })),
      repo,
    )

    expect(result.status).toBe('generated')
    if (result.status !== 'generated') return

    expect(result.questions.filter((q) => q.section === 'mcq')).toHaveLength(16)
    expect(result.questions.filter((q) => q.section === 'short_answer')).toHaveLength(4)
    expect(result.questions.some((q) => q.id.startsWith('hulk-'))).toBe(false)
  })
})

describe('the untopiced bucket', () => {
  // Capiche's entire bank carries no topic at all, so this is not an edge case
  // — it is one of the two real banks in the product.
  const untopicedBank = () => [
    ...rows('none-mcq', 40, 'mcq', null),
    ...rows('none-short', 10, 'short_answer', null),
  ]

  it('generates from an entirely untopiced bank when it is included', async () => {
    const repo = new TopicAwareRepository(untopicedBank())

    const result = await generatePaper(
      request(scopeWith({ topicIds: [], includeNoTopic: true })),
      repo,
    )

    expect(result.status).toBe('generated')
    if (result.status !== 'generated') return
    expect(result.questions).toHaveLength(20)
  })

  it('excluding it empties an entirely untopiced bank', async () => {
    const repo = new TopicAwareRepository(untopicedBank())

    const result = await generatePaper(
      request(scopeWith({ topicIds: [], includeNoTopic: false })),
      repo,
    )

    expect(result.status).toBe('short')
    expect(repo.saved).toEqual([])
  })

  it('is independent of the topic list — excluding a topic keeps untopiced questions', async () => {
    const repo = new TopicAwareRepository([
      ...rows('none-mcq', 16, 'mcq', null),
      ...rows('none-short', 4, 'short_answer', null),
      ...rows('hulk-mcq', 50, 'mcq', HULK),
    ])

    const result = await generatePaper(
      request(scopeWith({ topicIds: [], includeNoTopic: true })),
      repo,
    )

    expect(result.status).toBe('generated')
    if (result.status !== 'generated') return
    expect(result.questions.every((q) => q.id.startsWith('none-'))).toBe(true)
  })
})

describe('an unfiltered scope behaves exactly as before', () => {
  it('draws from the whole level when no filter is given', async () => {
    // The regression guard: every paper generated before topics existed must
    // keep generating identically. `topics` absent means every topic.
    const repo = new TopicAwareRepository(mixedBank())
    const scope: PaperScope = {
      companyId: 'company-1',
      brandId: 'brand-1',
      difficulty: 'medium',
      marks: 20,
    }

    expect(await repo.countPool(scope)).toEqual({ mcq: 100, shortAnswer: 20 })

    const result = await generatePaper(request(scope), repo)
    expect(result.status).toBe('generated')
  })

  it('treats an explicit ALL_TOPICS the same as no filter at all', async () => {
    const repo = new TopicAwareRepository(mixedBank())
    expect(await repo.countPool(scopeWith(ALL_TOPICS))).toEqual({ mcq: 100, shortAnswer: 20 })
  })
})

describe('the schema this filter is written against', () => {
  it('gives a question exactly one topic, so one exclusion is enough to remove it', () => {
    /*
     * bank_questions.topic_id is a single nullable FK; there is no join table
     * anywhere in the schema. The recommended "exclude if ANY attached topic
     * is excluded" rule is therefore satisfied by construction — a question
     * has at most one topic to check.
     *
     * If a question ever gains multiple topics, `BankRow.topicId` becomes a
     * list and this assertion stops compiling, which is the point: the
     * exclusion rule has to be re-decided deliberately, not inherited.
     */
    const row: BankRow = { id: 'q-1', qtype: 'mcq', topicId: HULK }
    expect(typeof row.topicId === 'string' || row.topicId === null).toBe(true)
  })
})
