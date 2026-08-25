import { z } from 'zod'
import { DIFFICULTIES, type Difficulty } from '@/lib/bank/vocabulary'
import { blueprintFor } from '@/lib/papers/blueprint'
import { totalPossiblePapers, type PoolCounts } from '@/lib/papers/combinations'

/**
 * The availability panel's arithmetic, with no database attached.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHY THIS SITS IN lib/ RATHER THAN NEXT TO ITS CALLER.                     │
 * │                                                                           │
 * │ server/papers/availability.ts imports the Supabase server client, which   │
 * │ reaches for next/headers and cannot be loaded outside a request. Anything │
 * │ defined in that file is therefore unreachable from the unit suite, and    │
 * │ this arithmetic is exactly what wants asserting: it decides whether a     │
 * │ chef is told 1,030 questions exist or 0.                                  │
 * │                                                                           │
 * │ Moved here so it can be tested directly. The server module re-exports it, │
 * │ so no caller changed.                                                     │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

export const poolCountRowSchema = z.object({
  difficulty: z.enum(['easy', 'medium', 'hard']),
  qtype: z.enum(['mcq', 'short_answer']),
  n: z.coerce.number().int().min(0),
})

export type PoolCountRow = z.infer<typeof poolCountRowSchema>

export interface LevelAvailability {
  difficulty: Difficulty
  pool: PoolCounts
  combinationsBySize: Record<number, number>
}

/**
 * Turn the counts the database returned into one entry per difficulty.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ EVERY NUMBER ON THE PANEL COMES FROM `rows` AND NOWHERE ELSE. No default, ║
 * ║ no seed, no remembered figure.                                            ║
 * ║                                                                           ║
 * ║ That is what the `?? 0` is for: a difficulty the query returned no row    ║
 * ║ for reports ZERO — not omitted, and not inherited from the level above.   ║
 * ║ Import 1,030 Easy questions for a brand and its Medium and Hard must both ║
 * ║ read 0 until those are imported too, because a chef who trusts an         ║
 * ║ invented count builds a paper that generation cannot fill.                ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Always returns all three levels in a fixed order: the panel renders three
 * rows, and a level missing from the result would drop one silently.
 *
 * The combination arithmetic is NOT reimplemented here — totalPossiblePapers()
 * does it, the same function the generator uses, so the number on the screen
 * and the number that decides exhaustion cannot disagree.
 */
export function buildLevels(
  rows: readonly PoolCountRow[],
  sizes: readonly number[],
): LevelAvailability[] {
  return DIFFICULTIES.map((difficulty) => {
    const forLevel = rows.filter((r) => r.difficulty === difficulty)
    const pool: PoolCounts = {
      mcq: forLevel.find((r) => r.qtype === 'mcq')?.n ?? 0,
      shortAnswer: forLevel.find((r) => r.qtype === 'short_answer')?.n ?? 0,
    }

    const combinationsBySize: Record<number, number> = {}
    for (const marks of sizes) {
      combinationsBySize[marks] = totalPossiblePapers(pool, blueprintFor(marks))
    }
    return { difficulty, pool, combinationsBySize }
  })
}
