import { describe, it, expect } from 'vitest'
import {
  defaultLevel,
  describeLevel,
  difficultyLevelSchema,
  DIFFICULTY_MAX,
  DIFFICULTY_MIN,
  levelsForRange,
  matchingLevels,
  rangeForLevel,
  sortLevels,
  type DifficultyLevel,
} from '../../src/lib/exams/difficulty'

/**
 * Company-defined difficulty levels (0052).
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHAT THESE PIN, AND WHY IT IS NOT OBVIOUS.                                │
 * │                                                                           │
 * │ A level is a NAME FOR A BAND of the 1-5 scale, not a replacement for it.  │
 * │ Picking one writes two numbers onto a rule and is then forgotten, so      │
 * │ draw_paper() never learns the concept exists.                             │
 * │                                                                           │
 * │ Two consequences look like bugs until you know they are deliberate, and   │
 * │ both are asserted below rather than left to be rediscovered:              │
 * │                                                                           │
 * │   overlapping bands are legal   — "Easy 1-2" and "Starter 1-2" can both   │
 * │                                   exist, so matchingLevels returns a LIST │
 * │   a saved rule may match none   — its numbers were typed by hand, or the  │
 * │                                   band was renamed since                  │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

const level = (
  name: string,
  min: number,
  max: number,
  extra: Partial<DifficultyLevel> = {},
): DifficultyLevel => ({
  id: `id-${name}`,
  name,
  min_level: min,
  max_level: max,
  sort_order: 0,
  is_default: false,
  ...extra,
})

const LEVELS: DifficultyLevel[] = [
  level('Beginner', 1, 1, { sort_order: 1 }),
  level('Easy', 1, 2, { sort_order: 2 }),
  level('Medium', 3, 3, { sort_order: 3, is_default: true }),
  level('Advanced', 4, 5, { sort_order: 4 }),
]

describe('rangeForLevel', () => {
  it('produces exactly the two columns exam_rules already has', () => {
    // The whole design rests on this: a level sets difficulty_min/max and adds
    // no third field, so draw_paper is untouched.
    expect(rangeForLevel(level('Advanced', 4, 5))).toEqual({
      difficultyMin: 4,
      difficultyMax: 5,
    })
  })

  it('handles a single-value band', () => {
    expect(rangeForLevel(level('Medium', 3, 3))).toEqual({ difficultyMin: 3, difficultyMax: 3 })
  })
})

describe('matchingLevels', () => {
  it('finds the level a rule was built from', () => {
    expect(matchingLevels(LEVELS, 4, 5).map((l) => l.name)).toEqual(['Advanced'])
  })

  /**
   * 0052 allows overlapping bands on purpose. Returning one would mean picking
   * arbitrarily and labelling a rule "Easy" when its author chose "Starter".
   */
  it('returns every level describing the same band, not the first', () => {
    const overlapping = [...LEVELS, level('Starter', 1, 2)]
    expect(matchingLevels(overlapping, 1, 2).map((l) => l.name).sort()).toEqual([
      'Easy',
      'Starter',
    ])
  })

  it('returns nothing for a band no level describes', () => {
    // Ordinary, not an error: the numbers were typed directly, or the band was
    // renamed after the rule was saved. The UI shows the numbers instead.
    expect(matchingLevels(LEVELS, 2, 4)).toEqual([])
  })
})

describe('levelsForRange', () => {
  it('offers only levels wholly inside the range', () => {
    // Asked for 1-3: Beginner (1-1) and Easy (1-2) fit; Advanced (4-5) does not.
    expect(levelsForRange(LEVELS, 1, 3).map((l) => l.name)).toEqual(['Beginner', 'Easy', 'Medium'])
  })

  /**
   * `contains`, not `overlaps`. A level spanning 2-5 offered for a 1-3 range
   * would draw questions at 4 and 5 that the range excludes — a label whose
   * meaning contradicts the numbers beside it.
   */
  it('excludes a level that would reach outside the range', () => {
    const wide = [...LEVELS, level('Most', 2, 5)]
    expect(levelsForRange(wide, 1, 3).map((l) => l.name)).not.toContain('Most')
  })

  it('offers everything for the full range', () => {
    // The positive control: if this returned [] the assertions above would pass
    // against a function that always excludes.
    expect(levelsForRange(LEVELS, DIFFICULTY_MIN, DIFFICULTY_MAX)).toHaveLength(LEVELS.length)
  })
})

describe('defaultLevel', () => {
  it('finds the one marked default', () => {
    expect(defaultLevel(LEVELS)?.name).toBe('Medium')
  })

  it('returns null when a company has defined none', () => {
    // Reachable: 0052 seeds a default only for companies that had a profile to
    // attribute the rows to, and a company may delete the marked level.
    expect(defaultLevel(LEVELS.map((l) => ({ ...l, is_default: false })))).toBeNull()
  })
})

describe('sortLevels', () => {
  it('orders by sort_order', () => {
    const shuffled = [LEVELS[2], LEVELS[0], LEVELS[3], LEVELS[1]]
    expect(sortLevels(shuffled).map((l) => l.name)).toEqual([
      'Beginner',
      'Easy',
      'Medium',
      'Advanced',
    ])
  })

  it('breaks ties by name so the list does not reshuffle between renders', () => {
    // sort_order is not unique. Without the tiebreak two levels sharing one can
    // swap places on every render, which is why sortIssues() in exams/health.ts
    // breaks ties too.
    const tied = [level('Zebra', 1, 1, { sort_order: 5 }), level('Alpha', 2, 2, { sort_order: 5 })]
    expect(sortLevels(tied).map((l) => l.name)).toEqual(['Alpha', 'Zebra'])
    expect(sortLevels([...tied].reverse()).map((l) => l.name)).toEqual(['Alpha', 'Zebra'])
  })

  it('does not mutate the array it was given', () => {
    const input = [LEVELS[2], LEVELS[0]]
    sortLevels(input)
    expect(input[0].name).toBe('Medium')
  })
})

describe('describeLevel', () => {
  it('shows a single value plainly and a band as a range', () => {
    expect(describeLevel(level('Medium', 3, 3))).toBe('Medium (3)')
    expect(describeLevel(level('Advanced', 4, 5))).toBe('Advanced (4–5)')
  })
})

describe('difficultyLevelSchema', () => {
  it('accepts a well-formed level', () => {
    expect(
      difficultyLevelSchema.safeParse({ name: 'Advanced', minLevel: 4, maxLevel: 5 }).success,
    ).toBe(true)
  })

  it('refuses a band whose end is below its start', () => {
    // Mirrors difficulty_levels_ordered in 0052, so a reversed band is a field
    // error rather than a 23514 nobody can read. Such a band would match no
    // question at all and the rule would draw an empty paper silently.
    const result = difficultyLevelSchema.safeParse({ name: 'Broken', minLevel: 4, maxLevel: 2 })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toEqual(['maxLevel'])
    }
  })

  it('refuses a band outside the scale everything else keys on', () => {
    // 0 and 6 are not difficulties. questions.difficulty, exam_rules and
    // observed_difficulty_band all constrain to 1-5.
    expect(difficultyLevelSchema.safeParse({ name: 'Zero', minLevel: 0, maxLevel: 3 }).success).toBe(false)
    expect(difficultyLevelSchema.safeParse({ name: 'Six', minLevel: 3, maxLevel: 6 }).success).toBe(false)
  })

  it('requires a name and bounds its length', () => {
    expect(difficultyLevelSchema.safeParse({ name: '   ', minLevel: 1, maxLevel: 1 }).success).toBe(false)
    expect(
      difficultyLevelSchema.safeParse({ name: 'x'.repeat(41), minLevel: 1, maxLevel: 1 }).success,
    ).toBe(false)
    expect(
      difficultyLevelSchema.safeParse({ name: 'x'.repeat(40), minLevel: 1, maxLevel: 1 }).success,
    ).toBe(true)
  })

  it('coerces the strings a form sends', () => {
    // Every value from an HTML form is a string, including the numbers.
    const result = difficultyLevelSchema.safeParse({
      name: 'Easy',
      minLevel: '1',
      maxLevel: '2',
      sortOrder: '3',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.minLevel).toBe(1)
      expect(result.data.sortOrder).toBe(3)
    }
  })
})
