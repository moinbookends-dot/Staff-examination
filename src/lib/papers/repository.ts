import type { BankLocale, Difficulty, QuestionType } from '@/lib/bank/vocabulary'
import type { PaperBlueprint } from './blueprint'
import type { PoolCounts } from './combinations'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The seam between paper generation and the question bank.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE GENERATOR NEVER TOUCHES A DATABASE. IT TOUCHES THIS.                   ║
 * ║                                                                           ║
 * ║ Everything the generation service needs from the outside world is one of  ║
 * ║ the four methods below. That is what lets the entire algorithm — the      ║
 * ║ random draw, the never-twice rule, the exhaustion arithmetic, the retry   ║
 * ║ loop — be written and fully unit-tested while bank_questions does not     ║
 * ║ exist yet.                                                                ║
 * ║                                                                           ║
 * ║ When the bank lands, one adapter implements this against Postgres and     ║
 * ║ NOTHING in generate.ts changes. The tests keep running against a fake.    ║
 * ║                                                                           ║
 * ║ WHAT MUST NOT HAPPEN LATER: business rules leaking into an implementation ║
 * ║ of this interface. `drawQuestionIds` returns a random sample and nothing  ║
 * ║ more — it does not decide how many to draw, does not know about 80/20,    ║
 * ║ and must never filter by anything the caller did not ask for. A           ║
 * ║ repository that quietly excluded, say, recently-used questions would make ║
 * ║ the exhaustion arithmetic wrong in a way no test here could see.          ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Which bank a draw is scoped to. Every method carries the whole scope. */
export interface PaperScope {
  companyId: string
  brandId: string
  difficulty: Difficulty
  marks: number
}

/**
 * A question as the generator handles it: an id and its type, nothing else.
 *
 * No text, deliberately. The generator decides WHICH questions are on a paper
 * and in what order; resolving them into three languages is the renderer's
 * job, and fetching text here would mean carrying 50 questions × 3 languages
 * through a retry loop that discards most of what it draws.
 */
export interface DrawnQuestion {
  id: string
  qtype: QuestionType
}

/** One question's place on the finished paper. */
export interface PlacedQuestion extends DrawnQuestion {
  /** 1-based, printed beside the question and shared with the answer key. */
  questionNo: number
  section: QuestionType
}

export interface SavePaperInput {
  scope: PaperScope
  blueprint: PaperBlueprint
  epoch: number
  combinationHash: string
  questions: PlacedQuestion[]
  generatedBy: string
}

/**
 * The outcome of trying to persist a drawn paper.
 *
 * `duplicate` is not an error. It is the unique index doing its job under
 * concurrency, and the generator answers it by drawing again — so it has to be
 * a value the caller can branch on rather than an exception carrying a
 * Postgres error code the service would have to parse.
 */
export type SavePaperOutcome =
  | { status: 'saved'; paperId: string; paperNo: number }
  | { status: 'duplicate' }

export interface PaperRepository {
  /**
   * How many ACTIVE, undeleted questions of each type exist in this scope.
   *
   * Drives both the shortfall message and the exhaustion arithmetic, so it
   * must count exactly the population drawQuestionIds can return. A count that
   * includes drafts would promise questions the draw cannot produce.
   */
  countPool(scope: PaperScope): Promise<PoolCounts>

  /**
   * A random sample of `count` question ids, without replacement.
   *
   * May return FEWER than asked for if the pool is smaller; the caller checks
   * and reports a shortfall. It must not pad, retry or substitute.
   */
  drawQuestionIds(scope: PaperScope, qtype: QuestionType, count: number): Promise<string[]>

  /**
   * How many papers already exist for this scope in the given epoch.
   *
   * Epoch-scoped because a reset raises the epoch rather than deleting
   * history: the old rows stay, and the count that decides exhaustion starts
   * again from zero.
   */
  countGenerated(scope: PaperScope, epoch: number): Promise<number>

  /** The current generation epoch for a company. */
  currentEpoch(companyId: string): Promise<number>

  /**
   * Persist a drawn paper, or report that this exact combination already
   * exists.
   *
   * MUST be atomic and MUST rely on the unique index rather than a preceding
   * SELECT. Two chefs generating simultaneously both pass any check performed
   * before the insert.
   */
  save(input: SavePaperInput): Promise<SavePaperOutcome>
}

/**
 * Reading generated papers back.
 *
 * Separate from PaperRepository because the two have different callers and
 * different permissions: generation is papers.generate, history is
 * papers.read_history, and a chef holds both while an Editor holds only one.
 */
export interface PaperHistoryEntry {
  id: string
  paperNo: number
  brandId: string
  brandName: string
  difficulty: Difficulty
  marks: number
  questionCount: number
  generatedByName: string
  generatedAt: string
  /** Which of the six files exist. Absent ones are offered as "regenerate". */
  availableFiles: { locale: BankLocale; kind: 'paper' | 'key' }[]
}

export interface PaperHistoryPage {
  rows: PaperHistoryEntry[]
  total: number
  page: number
  pageSize: number
}

export interface PaperHistoryFilters {
  brandId?: string
  difficulty?: Difficulty
  marks?: number
  from?: string
  to?: string
  q?: string
  page: number
  pageSize: number
}

export interface PaperHistoryRepository {
  list(companyId: string, filters: PaperHistoryFilters): Promise<PaperHistoryPage>
  find(companyId: string, paperId: string): Promise<PaperHistoryEntry | null>
}
