import { describe, it, expect } from 'vitest'
import { generatePaper } from '@/lib/papers/generate'
import {
  ALL_ITEMS,
  ALL_TOPICS,
  type PaperRepository,
  type PaperScope,
  type SavePaperInput,
  type SavePaperOutcome,
} from '@/lib/papers/repository'
import type { QuestionType } from '@/lib/bank/vocabulary'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Taking a recipe off the menu, and keeping it off the paper.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ "Hulk" IS A REAL DISH IN THIS BANK — a Capiche pizza, 18 questions.       ║
 * ║                                                                           ║
 * ║ The names below are the real ones so a failure reads like the product     ║
 * ║ rather than like a fixture. What is asserted is the rule, not the data:   ║
 * ║ a question about a withdrawn dish must never be drawn, and a question     ║
 * ║ that merely MENTIONS one alongside a current dish must not either.        ║
 * ║                                                                           ║
 * ║ That second case is the one a single item_id column could not express     ║
 * ║ and the reason bank_question_items is a join table: "Which allergen is    ║
 * ║ common to both X and Y?" is as much about Y as it is about X.             ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */

interface BankRow {
  id: string
  qtype: QuestionType
  /** Every item this question is about. Empty = names no known dish. */
  itemIds: string[]
  topicId?: string | null
}

const HULK = 'item-hulk'
const MARGHERITA = 'item-margherita'
const TRUFFLE = 'item-truffle'

/**
 * A bank that applies the item and topic filters exactly as 0079 does: as
 * predicates over the candidates, evaluated before anything is sampled.
 */
class ItemAwareRepository implements PaperRepository {
  saved: SavePaperInput[] = []
  drawnScopes: PaperScope[] = []

  constructor(private readonly rows: BankRow[]) {}

  private eligible(scope: PaperScope, qtype?: QuestionType): BankRow[] {
    const items = scope.items ?? ALL_ITEMS
    const topics = scope.topics ?? ALL_TOPICS

    return this.rows.filter((row) => {
      if (qtype && row.qtype !== qtype) return false

      // ANY excluded item disqualifies the whole question.
      if (row.itemIds.some((id) => items.excludedItemIds.includes(id))) return false
      if (row.itemIds.length === 0 && !items.includeNoItem) return false

      if (topics.topicIds !== null) {
        if (row.topicId == null) return topics.includeNoTopic
        if (!topics.topicIds.includes(row.topicId)) return false
      }

      return true
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

const rows = (
  prefix: string,
  n: number,
  qtype: QuestionType,
  itemIds: string[],
  topicId: string | null = 'topic-1',
): BankRow[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `${prefix}-${String(i + 1).padStart(3, '0')}`,
    qtype,
    itemIds,
    topicId,
  }))

const scopeWith = (
  items: PaperScope['items'],
  topics?: PaperScope['topics'],
): PaperScope => ({
  companyId: 'company-1',
  brandId: 'brand-1',
  difficulty: 'easy',
  marks: 20,
  items,
  topics,
})

const request = (scope: PaperScope) => ({ scope, generatedBy: 'user-1' })

/** 80 questions about Margherita, 20 about Hulk — the §8 shape. */
const menuBank = () => [
  ...rows('marg-mcq', 64, 'mcq', [MARGHERITA]),
  ...rows('marg-short', 16, 'short_answer', [MARGHERITA]),
  ...rows('hulk-mcq', 16, 'mcq', [HULK]),
  ...rows('hulk-short', 4, 'short_answer', [HULK]),
]

describe('a withdrawn recipe never reaches a paper', () => {
  it('drops it from the eligible pool and from the generated paper', async () => {
    const repo = new ItemAwareRepository(menuBank())

    expect(await repo.countPool(scopeWith(ALL_ITEMS))).toEqual({ mcq: 80, shortAnswer: 20 })

    const scope = scopeWith({ excludedItemIds: [HULK], includeNoItem: true })
    expect(await repo.countPool(scope)).toEqual({ mcq: 64, shortAnswer: 16 })

    const result = await generatePaper(request(scope), repo)

    expect(result.status).toBe('generated')
    if (result.status !== 'generated') return

    expect(result.questions.filter((q) => q.id.startsWith('hulk-'))).toEqual([])
    expect(result.questions).toHaveLength(20)
  })

  it('excludes a question that merely mentions it alongside a current dish', async () => {
    /*
     * The comparison case. This question is about Margherita too, and a
     * generator that kept it because Margherita is still on the menu would put
     * the withdrawn dish in front of a candidate anyway.
     */
    const repo = new ItemAwareRepository([
      ...rows('both-mcq', 30, 'mcq', [MARGHERITA, HULK]),
      ...rows('marg-mcq', 30, 'mcq', [MARGHERITA]),
      ...rows('marg-short', 10, 'short_answer', [MARGHERITA]),
    ])

    const scope = scopeWith({ excludedItemIds: [HULK], includeNoItem: true })

    expect(await repo.countPool(scope)).toEqual({ mcq: 30, shortAnswer: 10 })

    const result = await generatePaper(request(scope), repo)
    expect(result.status).toBe('generated')
    if (result.status !== 'generated') return

    expect(result.questions.some((q) => q.id.startsWith('both-'))).toBe(false)
  })

  it('stays excluded across repeated generations', async () => {
    const repo = new ItemAwareRepository(menuBank())
    const scope = scopeWith({ excludedItemIds: [HULK], includeNoItem: true })

    for (let i = 0; i < 10; i += 1) await generatePaper(request(scope), repo)

    expect(repo.saved.length).toBeGreaterThan(0)
    for (const paper of repo.saved) {
      expect(paper.questions.some((q) => q.id.startsWith('hulk-'))).toBe(false)
    }
  })

  it('carries the exclusion into every draw, not just the count', async () => {
    const repo = new ItemAwareRepository(menuBank())
    const items = { excludedItemIds: [HULK, TRUFFLE], includeNoItem: false }

    await generatePaper(request(scopeWith(items)), repo)

    expect(repo.drawnScopes.length).toBeGreaterThanOrEqual(2)
    for (const scope of repo.drawnScopes) expect(scope.items).toEqual(items)
  })

  it('excludes several withdrawn dishes at once', async () => {
    const repo = new ItemAwareRepository([
      ...rows('marg-mcq', 16, 'mcq', [MARGHERITA]),
      ...rows('marg-short', 4, 'short_answer', [MARGHERITA]),
      ...rows('hulk-mcq', 40, 'mcq', [HULK]),
      ...rows('truffle-mcq', 40, 'mcq', [TRUFFLE]),
    ])

    const result = await generatePaper(
      request(scopeWith({ excludedItemIds: [HULK, TRUFFLE], includeNoItem: true })),
      repo,
    )

    expect(result.status).toBe('generated')
    if (result.status !== 'generated') return
    expect(result.questions.every((q) => q.id.startsWith('marg-'))).toBe(true)
  })
})

describe('availability after exclusions', () => {
  it('blocks generation rather than issuing a smaller paper', async () => {
    // 12 MCQs left after the exclusion; a 20-mark paper needs 16.
    const repo = new ItemAwareRepository([
      ...rows('marg-mcq', 12, 'mcq', [MARGHERITA]),
      ...rows('marg-short', 10, 'short_answer', [MARGHERITA]),
      ...rows('hulk-mcq', 88, 'mcq', [HULK]),
    ])

    const result = await generatePaper(
      request(scopeWith({ excludedItemIds: [HULK], includeNoItem: true })),
      repo,
    )

    expect(result.status).toBe('short')
    if (result.status !== 'short') return

    expect(result.shortfalls).toEqual([{ qtype: 'mcq', needed: 16, available: 12 }])
    expect(repo.saved).toEqual([])
  })

  it('counts a question once even when it names two withdrawn dishes', async () => {
    /*
     * The reason the eligible pool is COUNTED rather than subtracted. This
     * question belongs to both excluded items; removing it once per item would
     * report a pool two smaller than it is.
     */
    const repo = new ItemAwareRepository([
      ...rows('both-mcq', 1, 'mcq', [HULK, TRUFFLE]),
      ...rows('marg-mcq', 20, 'mcq', [MARGHERITA]),
      ...rows('marg-short', 5, 'short_answer', [MARGHERITA]),
    ])

    const pool = await repo.countPool(
      scopeWith({ excludedItemIds: [HULK, TRUFFLE], includeNoItem: true }),
    )

    expect(pool).toEqual({ mcq: 20, shortAnswer: 5 })
  })
})

describe('questions naming no known item', () => {
  it('are drawable by default', async () => {
    const repo = new ItemAwareRepository([
      ...rows('none-mcq', 16, 'mcq', []),
      ...rows('none-short', 4, 'short_answer', []),
    ])

    const result = await generatePaper(request(scopeWith(ALL_ITEMS)), repo)
    expect(result.status).toBe('generated')
  })

  it('can be held back when the admin chooses', async () => {
    // The safety valve: tagging was recovered from text and is not complete,
    // so somebody worried about a missed mention can drop the residue.
    const repo = new ItemAwareRepository([
      ...rows('none-mcq', 16, 'mcq', []),
      ...rows('none-short', 4, 'short_answer', []),
    ])

    const result = await generatePaper(
      request(scopeWith({ excludedItemIds: [], includeNoItem: false })),
      repo,
    )

    expect(result.status).toBe('short')
    expect(repo.saved).toEqual([])
  })

  it('are unaffected by excluding a dish', async () => {
    const repo = new ItemAwareRepository([
      ...rows('none-mcq', 16, 'mcq', []),
      ...rows('none-short', 4, 'short_answer', []),
      ...rows('hulk-mcq', 50, 'mcq', [HULK]),
    ])

    const result = await generatePaper(
      request(scopeWith({ excludedItemIds: [HULK], includeNoItem: true })),
      repo,
    )

    expect(result.status).toBe('generated')
    if (result.status !== 'generated') return
    expect(result.questions.every((q) => q.id.startsWith('none-'))).toBe(true)
  })
})

describe('topics and items filter together', () => {
  it('admits only what satisfies BOTH', async () => {
    /*
     * §10: an excluded recipe must never re-enter the pool because another
     * filter allowed it. Only the rows matching the kept topic AND not naming
     * the withdrawn dish may be drawn.
     */
    const repo = new ItemAwareRepository([
      ...rows('keep-mcq', 16, 'mcq', [MARGHERITA], 'topic-keep'),
      ...rows('keep-short', 4, 'short_answer', [MARGHERITA], 'topic-keep'),
      // Right topic, withdrawn dish.
      ...rows('keep-hulk', 40, 'mcq', [HULK], 'topic-keep'),
      // Right dish, dropped topic.
      ...rows('drop-marg', 40, 'mcq', [MARGHERITA], 'topic-drop'),
    ])

    const scope = scopeWith(
      { excludedItemIds: [HULK], includeNoItem: true },
      { topicIds: ['topic-keep'], includeNoTopic: false },
    )

    expect(await repo.countPool(scope)).toEqual({ mcq: 16, shortAnswer: 4 })

    const result = await generatePaper(request(scope), repo)
    expect(result.status).toBe('generated')
    if (result.status !== 'generated') return

    expect(result.questions.every((q) => q.id.startsWith('keep-'))).toBe(true)
    expect(result.questions.some((q) => q.id.startsWith('keep-hulk'))).toBe(false)
  })
})

describe('the paper records what it was generated with', () => {
  it('stores the configuration alongside the paper', async () => {
    const repo = new ItemAwareRepository(menuBank())
    const scope = scopeWith({ excludedItemIds: [HULK], includeNoItem: true })

    const config = {
      topicIds: null,
      includeNoTopic: true,
      excludedItemIds: [HULK],
      includeNoItem: true,
      requested: { mcq: 16, shortAnswer: 4 },
    }

    const result = await generatePaper({ ...request(scope), config }, repo)

    expect(result.status).toBe('generated')
    expect(repo.saved).toHaveLength(1)
    // Auditability: "why is there no Hulk question here" has an answer.
    expect(repo.saved[0].config).toEqual(config)
    expect(repo.saved[0].config?.excludedItemIds).toContain(HULK)
  })

  it('is optional — a paper generated without one still saves', async () => {
    const repo = new ItemAwareRepository(menuBank())
    const result = await generatePaper(request(scopeWith(ALL_ITEMS)), repo)

    expect(result.status).toBe('generated')
    expect(repo.saved[0].config).toBeUndefined()
  })
})

describe('an unfiltered scope behaves exactly as before', () => {
  it('draws from the whole level when nothing is withdrawn', async () => {
    const repo = new ItemAwareRepository(menuBank())
    const scope: PaperScope = {
      companyId: 'company-1',
      brandId: 'brand-1',
      difficulty: 'easy',
      marks: 20,
    }

    expect(await repo.countPool(scope)).toEqual({ mcq: 80, shortAnswer: 20 })
    expect((await generatePaper(request(scope), repo)).status).toBe('generated')
  })
})
