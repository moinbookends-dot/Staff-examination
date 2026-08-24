import type { QuestionType } from '@/lib/bank/vocabulary'
import { blueprintFor, countFor, type PaperBlueprint } from './blueprint'
import {
  isEffectivelyUnlimited,
  isExhausted,
  totalPossiblePapers,
  type PoolCounts,
} from './combinations'
import { combinationHash } from './paper-hash'
import type {
  GenerationConfig,
  PaperRepository,
  PaperScope,
  PlacedQuestion,
} from './repository'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The generation service.
 *
 * Draw a paper that has never been drawn before, or explain precisely why one
 * cannot be. Every dependency arrives through PaperRepository, so this file
 * has no database, no framework and no I/O of its own — which is what makes
 * the whole never-twice rule unit-testable before the bank exists.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE ORDER OF THE CHECKS IS THE DESIGN.                                    │
 * │                                                                           │
 * │   1. shortfall   — can a paper of this size be built at all?              │
 * │   2. exhaustion  — have all possible papers already been issued?          │
 * │   3. draw + save — retry on collision                                     │
 * │                                                                           │
 * │ Reversed, a bank holding 12 MCQs would be reported as "exhausted" rather  │
 * │ than "you need 4 more questions" — technically true and useless, since    │
 * │ C(12,16) is 0 and every possible paper (none) has indeed been generated.  │
 * │ Shortfall first means the message names the fixable thing.                │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * How many times to redraw when the combination already exists.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHY A BOUND AT ALL, GIVEN EXHAUSTION IS CHECKED FIRST.                    │
 * │                                                                           │
 * │ Because "not exhausted" does not mean "likely to hit a new combination".  │
 * │ A pool of 17 MCQs choosing 16 has 17 possible papers; once 16 exist, a    │
 * │ random draw has a 1-in-17 chance of finding the last one, and an          │
 * │ unbounded loop would hammer the database while technically making         │
 * │ progress.                                                                 │
 * │                                                                           │
 * │ 40 attempts leaves the far tail (>99.9% for that case) covered while      │
 * │ bounding the work. Running out is reported as `exhausted` rather than as  │
 * │ a failure: from the user's side "we could not find a new combination" and │
 * │ "there are none left" call for the same action — add more questions.      │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export const MAX_DRAW_ATTEMPTS = 40

export interface GenerateRequest {
  scope: PaperScope
  generatedBy: string
  /**
   * The filters this paper is being generated with, recorded alongside it.
   *
   * Passed through untouched — the generator does not interpret it. Optional
   * because the algorithm is testable without one, and because a paper is
   * still a valid paper when nobody chose to record why it looks as it does.
   */
  config?: GenerationConfig
}

export interface Shortfall {
  qtype: QuestionType
  needed: number
  available: number
}

export type GenerateResult =
  | {
      status: 'generated'
      paperId: string
      paperNo: number
      questions: PlacedQuestion[]
      /** For "1 of 2.4 million possible papers" on the success screen. */
      totalCombinations: number
      unlimited: boolean
    }
  | { status: 'short'; shortfalls: Shortfall[]; pool: PoolCounts; blueprint: PaperBlueprint }
  | { status: 'exhausted'; generated: number; totalCombinations: number }
  | { status: 'failed'; message: string }

/**
 * Injected so tests are deterministic.
 *
 * Production passes nothing and gets Math.random. A test passes a seeded
 * generator and gets a repeatable shuffle — which is the only way to assert
 * that ordering is a shuffle at all rather than assert on a specific order and
 * pin the implementation.
 */
export interface GenerateOptions {
  random?: () => number
  maxAttempts?: number
}

/**
 * Fisher-Yates, on a copy.
 *
 * In place would mutate the caller's array — here that is the freshly drawn id
 * list, so it would be harmless today and a bug the first time a caller reused
 * the input.
 */
export function shuffle<T>(items: readonly T[], random: () => number = Math.random): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/**
 * Lay the drawn ids out as a printed paper.
 *
 * MCQs first, shuffled among themselves; then short answers, shuffled among
 * themselves. The two sections are NOT interleaved — a printed paper that
 * mixes formats is harder to sit and its answer key harder to check, and
 * Section A / Section B is what the header promises.
 *
 * Numbering runs continuously across both sections, because the number beside
 * a question is the only handle the answer key has for it.
 */
export function placeQuestions(
  mcqIds: readonly string[],
  shortIds: readonly string[],
  random: () => number = Math.random,
): PlacedQuestion[] {
  const ordered: PlacedQuestion[] = []
  let n = 1

  for (const id of shuffle(mcqIds, random)) {
    ordered.push({ id, qtype: 'mcq', section: 'mcq', questionNo: n })
    n += 1
  }
  for (const id of shuffle(shortIds, random)) {
    ordered.push({ id, qtype: 'short_answer', section: 'short_answer', questionNo: n })
    n += 1
  }

  return ordered
}

export async function generatePaper(
  request: GenerateRequest,
  repository: PaperRepository,
  options: GenerateOptions = {},
): Promise<GenerateResult> {
  const random = options.random ?? Math.random
  const maxAttempts = options.maxAttempts ?? MAX_DRAW_ATTEMPTS
  const { scope, generatedBy, config } = request

  let blueprint: PaperBlueprint
  try {
    blueprint = blueprintFor(scope.marks)
  } catch (err) {
    // An unusable paper size reached here from paper_settings, whose CHECK
    // constraint should have made that impossible. Report it rather than
    // throwing into a server action that has no boundary to catch it.
    return { status: 'failed', message: err instanceof Error ? err.message : 'Invalid paper size.' }
  }

  // ── 1. Can a paper be built at all? ───────────────────────────────────────
  const pool = await repository.countPool(scope)

  const shortfalls: Shortfall[] = []
  for (const qtype of ['mcq', 'short_answer'] as const) {
    const needed = countFor(blueprint, qtype)
    const available = qtype === 'mcq' ? pool.mcq : pool.shortAnswer
    if (available < needed) shortfalls.push({ qtype, needed, available })
  }

  // Both shortfalls are reported, not just the first. An Editor about to go
  // and write questions needs the whole list, or they make two trips.
  if (shortfalls.length > 0) {
    return { status: 'short', shortfalls, pool, blueprint }
  }

  // ── 2. Is there anything left to draw? ────────────────────────────────────
  const epoch = await repository.currentEpoch(scope.companyId)
  const total = totalPossiblePapers(pool, blueprint)
  const generated = await repository.countGenerated(scope, epoch)

  if (isExhausted(generated, total)) {
    return { status: 'exhausted', generated, totalCombinations: total }
  }

  // ── 3. Draw, fingerprint, save; retry on collision ────────────────────────
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const [mcqIds, shortIds] = await Promise.all([
      repository.drawQuestionIds(scope, 'mcq', blueprint.mcqCount),
      repository.drawQuestionIds(scope, 'short_answer', blueprint.shortAnswerCount),
    ])

    /*
     * The pool was counted a moment ago and could have shrunk since — an
     * Editor archiving a question mid-generation is entirely ordinary. Trusting
     * the earlier count would produce a 19-question paper labelled 20 marks,
     * which is worse than refusing.
     */
    if (mcqIds.length < blueprint.mcqCount || shortIds.length < blueprint.shortAnswerCount) {
      return {
        status: 'short',
        shortfalls: [
          ...(mcqIds.length < blueprint.mcqCount
            ? [{ qtype: 'mcq' as const, needed: blueprint.mcqCount, available: mcqIds.length }]
            : []),
          ...(shortIds.length < blueprint.shortAnswerCount
            ? [
                {
                  qtype: 'short_answer' as const,
                  needed: blueprint.shortAnswerCount,
                  available: shortIds.length,
                },
              ]
            : []),
        ],
        pool: { mcq: mcqIds.length, shortAnswer: shortIds.length },
        blueprint,
      }
    }

    const questions = placeQuestions(mcqIds, shortIds, random)

    /*
     * Hashed over the drawn ids as a SET — placeQuestions has already shuffled
     * them, and the fingerprint must not depend on that shuffle. combinationHash
     * sorts internally, so passing the placed order is safe and passing the
     * unplaced order would be identical.
     */
    let hash: string
    try {
      hash = combinationHash(questions.map((q) => q.id))
    } catch (err) {
      // A repeated id inside one draw: a repository bug, not a user error.
      return {
        status: 'failed',
        message: err instanceof Error ? err.message : 'The draw produced an invalid paper.',
      }
    }

    const outcome = await repository.save({
      scope,
      blueprint,
      epoch,
      combinationHash: hash,
      questions,
      generatedBy,
      config,
    })

    if (outcome.status === 'saved') {
      return {
        status: 'generated',
        paperId: outcome.paperId,
        paperNo: outcome.paperNo,
        questions,
        totalCombinations: total,
        unlimited: isEffectivelyUnlimited(total),
      }
    }
    // 'duplicate' → this exact combination exists. Draw again.
  }

  /*
   * Out of attempts. Reported as exhausted rather than as a failure: the pool
   * is evidently so close to fully drawn that random sampling cannot find the
   * remainder, and the user's next action — add more questions — is the same
   * one the exhausted message asks for.
   *
   * `generated` is re-read rather than reused so the number shown is current
   * after however long the retries took.
   */
  const finalCount = await repository.countGenerated(scope, epoch)
  return { status: 'exhausted', generated: finalCount, totalCombinations: total }
}
