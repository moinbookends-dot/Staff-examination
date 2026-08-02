import { z } from 'zod'

/**
 * A company's own names for bands of the 1-5 difficulty scale (0052).
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ A LEVEL IS AN INPUT TO A RULE, NOT A FIELD ON ONE.                        │
 * │                                                                           │
 * │ Choosing "Advanced" writes difficulty_min = 4 and difficulty_max = 5 onto │
 * │ the rule and is then forgotten. exam_rules stores no level id, so         │
 * │ draw_paper() is untouched — it still selects on                           │
 * │ `q.difficulty between min and max` and still ranks its fallback by        │
 * │ `abs(q.difficulty - difficulty_min)`.                                     │
 * │                                                                           │
 * │ That one-way flow is what keeps the two from disagreeing. If a rule held  │
 * │ both, renaming a band or nudging its numbers would leave every rule ever  │
 * │ built from it claiming a level it no longer matches.                      │
 * │                                                                           │
 * │ The cost is real and worth naming: after saving, a rule cannot say WHICH  │
 * │ level it was built from — only the numbers survive. matchingLevels()      │
 * │ below recovers the label by looking for bands with those exact ends,      │
 * │ which is a display convenience and deliberately not a stored fact.        │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

/** The scale everything downstream keys on. Not configurable — see 0052. */
export const DIFFICULTY_MIN = 1
export const DIFFICULTY_MAX = 5

export interface DifficultyLevel {
  id: string
  name: string
  min_level: number
  max_level: number
  sort_order: number
  is_default: boolean
}

const levelBound = z.coerce.number().int().min(DIFFICULTY_MIN).max(DIFFICULTY_MAX)

export const difficultyLevelSchema = z
  .object({
    name: z.string().trim().min(1, 'Give the level a name.').max(40, 'That name is too long.'),
    minLevel: levelBound,
    maxLevel: levelBound,
    sortOrder: z.coerce.number().int().min(0).max(999).default(0),
    isDefault: z.boolean().default(false),
  })
  // Mirrors difficulty_levels_ordered in 0052. Checked here so a reversed band
  // is a field error on the form rather than a 23514 the user cannot read.
  .refine((v) => v.maxLevel >= v.minLevel, {
    message: 'The hardest level cannot be below the easiest.',
    path: ['maxLevel'],
  })

export type DifficultyLevelInput = z.infer<typeof difficultyLevelSchema>

/**
 * The rule fields a level sets. Exactly the two columns exam_rules already has.
 */
export function rangeForLevel(level: DifficultyLevel): {
  difficultyMin: number
  difficultyMax: number
} {
  return { difficultyMin: level.min_level, difficultyMax: level.max_level }
}

/**
 * Which levels describe this exact band.
 *
 * Plural, and that is not defensiveness: 0052 allows overlapping bands on
 * purpose, so a company may hold both "Easy 1-2" and "Starter 1-2" and neither
 * is more correct. Returning one would mean picking arbitrarily and showing a
 * rule as "Easy" when the author chose "Starter".
 *
 * Empty is ordinary too — a rule saved before a band was renamed, or one whose
 * numbers were typed directly. The UI shows the numbers in that case, which is
 * what the rule actually means.
 */
export function matchingLevels(
  levels: readonly DifficultyLevel[],
  difficultyMin: number,
  difficultyMax: number,
): DifficultyLevel[] {
  return levels.filter((l) => l.min_level === difficultyMin && l.max_level === difficultyMax)
}

/**
 * Every level whose band lies inside the given range.
 *
 * `contains`, not `overlaps`: asked for 1-3, a level spanning 2-5 would draw
 * questions at 4 and 5 that the range excludes. Offering it would let a chef
 * pick a label whose meaning contradicts the range they set beside it.
 */
export function levelsForRange(
  levels: readonly DifficultyLevel[],
  difficultyMin: number,
  difficultyMax: number,
): DifficultyLevel[] {
  return levels.filter((l) => l.min_level >= difficultyMin && l.max_level <= difficultyMax)
}

/** The level a new rule starts on, or null when a company has defined none. */
export function defaultLevel(levels: readonly DifficultyLevel[]): DifficultyLevel | null {
  return levels.find((l) => l.is_default) ?? null
}

/**
 * Display order: sort_order, then name.
 *
 * sort_order is not unique, and two levels sharing one would otherwise swap
 * places between renders — a list that reshuffles is one people stop trusting,
 * which is the same reason sortIssues() in lib/exams/health.ts breaks ties.
 */
export function sortLevels(levels: readonly DifficultyLevel[]): DifficultyLevel[] {
  return [...levels].sort(
    (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name),
  )
}

/** "Hard" → "Hard (4)"; "Foundation 1-3" → "Foundation (1–3)". */
export function describeLevel(level: DifficultyLevel): string {
  const band =
    level.min_level === level.max_level
      ? String(level.min_level)
      : `${level.min_level}–${level.max_level}`
  return `${level.name} (${band})`
}
