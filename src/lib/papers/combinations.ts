import type { PaperBlueprint } from './blueprint'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * How many different papers a pool can produce.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ BOTH ENDS OF THIS ARE REAL, AND THEY ARE ABSURDLY FAR APART.              ║
 * ║                                                                           ║
 * ║ At the target bank size — 1,000 questions at a level — a 20-mark paper    ║
 * ║ has C(1000,16) × C(1000,4) ≈ 2 × 10⁴⁵ possible combinations. Exhaustion   ║
 * ║ is unreachable and the message will never fire.                           ║
 * ║                                                                           ║
 * ║ At the FLOOR — exactly 16 MCQs and 4 short answers active — there is      ║
 * ║ exactly ONE possible paper, and the second generation must say so         ║
 * ║ immediately rather than retrying forever.                                 ║
 * ║                                                                           ║
 * ║ Both ends occur in this product: the floor is what a bank looks like on   ║
 * ║ the first day of entry, and 10⁴⁵ is what it looks like a month later. So  ║
 * ║ the arithmetic has to be exact where it is small and must not attempt to  ║
 * ║ be exact where it is astronomical.                                        ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHY A CAP RATHER THAN BigInt.                                             │
 * │                                                                           │
 * │ The only question ever asked of this number is "have we generated them    │
 * │ all?", compared against a count of rows in one company's history. That    │
 * │ count will never approach 2⁵³, so any total above the cap is equivalent   │
 * │ to infinity for every purpose this system has.                            │
 * │                                                                           │
 * │ BigInt would compute 10⁴⁵ exactly, cost allocation on every generate, and │
 * │ answer a question nobody asks. The cap also lets the loop stop early —    │
 * │ C(1000,16) bails after a handful of multiplications instead of sixteen.   │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Above this, a total is reported as "effectively unlimited".
 *
 * Well below Number.MAX_SAFE_INTEGER so intermediate products cannot lose
 * precision on the way up, and far above any plausible paper count.
 */
export const COMBINATION_CAP = 1e15

/** True when a total is the cap rather than a real count. */
export function isEffectivelyUnlimited(total: number): boolean {
  return total >= COMBINATION_CAP
}

/**
 * C(n, k) — how many ways to choose k from n, capped.
 *
 * Multiplicative form with the division applied each step, which keeps the
 * running value as small as possible and makes the early bail-out meaningful.
 * The alternative — computing n! / (k!(n-k)!) — overflows at n = 171 for a
 * pool that legitimately reaches 1,000.
 */
export function countCombinations(n: number, k: number): number {
  if (!Number.isInteger(n) || !Number.isInteger(k)) return 0
  if (k < 0 || n < 0) return 0

  // Asking for more questions than exist is not "zero ways" in a loose sense —
  // it is genuinely impossible, and the caller reports it as a shortfall
  // before ever reaching here.
  if (k > n) return 0

  // C(n,0) and C(n,n) are both 1: exactly one way to choose everything, and
  // one way to choose nothing. The floor case depends on this being right.
  if (k === 0 || k === n) return 1

  // C(n,k) === C(n,n-k); taking the smaller k halves the work.
  const kk = Math.min(k, n - k)

  let result = 1
  for (let i = 1; i <= kk; i += 1) {
    result = (result * (n - kk + i)) / i
    if (result >= COMBINATION_CAP) return COMBINATION_CAP
  }

  // Floating-point division leaves a value like 4845.000000000001; the true
  // answer is always an integer.
  return Math.round(result)
}

/** The pool available to one draw. */
export interface PoolCounts {
  mcq: number
  shortAnswer: number
}

/**
 * How many distinct papers this pool and blueprint can produce.
 *
 * The two sections are chosen independently, so the totals multiply. Capped
 * again after multiplying, since two sub-cap factors can exceed the cap.
 */
export function totalPossiblePapers(pool: PoolCounts, blueprint: PaperBlueprint): number {
  const mcqWays = countCombinations(pool.mcq, blueprint.mcqCount)
  const shortWays = countCombinations(pool.shortAnswer, blueprint.shortAnswerCount)

  // Either section being impossible makes the paper impossible.
  if (mcqWays === 0 || shortWays === 0) return 0

  const total = mcqWays * shortWays
  return total >= COMBINATION_CAP ? COMBINATION_CAP : total
}

/**
 * Has every possible paper already been generated?
 *
 * `generated` is a count of rows in the current epoch for this exact
 * (brand, difficulty, marks) combination — not a global paper count.
 *
 * Uses >= rather than ===, deliberately. They should be equal, but if history
 * ever holds MORE papers than the current pool can produce — which happens the
 * moment a question is archived after papers were drawn from a larger pool —
 * then === would report "not exhausted" forever and the retry loop would spin
 * against a set it can never extend.
 */
export function isExhausted(generated: number, total: number): boolean {
  if (total <= 0) return true
  if (isEffectivelyUnlimited(total)) return false
  return generated >= total
}
