import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  examRuleSchema,
  examSchema,
  assignmentSchema,
  EXAM_KINDS,
  DEFAULT_PAPER_MODE,
  DEFAULT_COUNTS_TOWARDS_ANALYTICS,
} from '@/lib/exams/rules'

/**
 * The exam contract at the application boundary.
 *
 * Everything here is validated again by the database. These tests exist so a
 * chef meets a readable message rather than a constraint name, and so the
 * kind → paper-mode defaults cannot quietly drift from the decision that
 * shaped the schema.
 */

describe('paper mode defaults', () => {
  it('covers every exam kind', () => {
    // A kind with no default would fall through to undefined and store null,
    // and the column is NOT NULL — a runtime failure on the first save of a
    // newly added kind.
    for (const kind of EXAM_KINDS) {
      expect(DEFAULT_PAPER_MODE[kind], `no paper mode for ${kind}`).toBeDefined()
      expect(DEFAULT_COUNTS_TOWARDS_ANALYTICS[kind], `no analytics flag for ${kind}`).toBeDefined()
    }
  })

  it('freezes the exams whose scores must be comparable', () => {
    expect(DEFAULT_PAPER_MODE.official).toBe('fixed')
    expect(DEFAULT_PAPER_MODE.monthly).toBe('fixed')
    expect(DEFAULT_PAPER_MODE.annual).toBe('fixed')
    expect(DEFAULT_PAPER_MODE.practical).toBe('fixed')
  })

  it('redraws the ones people repeat', () => {
    // Repeated practice must not be repeated memorisation.
    expect(DEFAULT_PAPER_MODE.practice).toBe('per_attempt')
    expect(DEFAULT_PAPER_MODE.quiz).toBe('per_attempt')
  })

  it('keeps low-stakes responses out of difficulty calibration', () => {
    expect(DEFAULT_COUNTS_TOWARDS_ANALYTICS.practice).toBe(false)
    expect(DEFAULT_COUNTS_TOWARDS_ANALYTICS.quiz).toBe(false)
    expect(DEFAULT_COUNTS_TOWARDS_ANALYTICS.official).toBe(true)
  })

  it('matches the enum the database declares', () => {
    // The migration and this list must agree, or a kind valid in the UI is
    // rejected on insert.
    const sql = readFileSync(
      resolve(process.cwd(), 'supabase/migrations/20260726120000_0001_extensions_and_enums.sql'),
      'utf-8',
    )
    const block = sql.slice(sql.indexOf('create type public.exam_kind'))
    const declared = [...block.slice(0, block.indexOf(');')).matchAll(/'([a-z_]+)'/g)].map((m) => m[1])
    expect(declared.sort()).toEqual([...EXAM_KINDS].sort())
  })
})

describe('selection rules', () => {
  it('accepts a minimal rule and fills the defaults', () => {
    const parsed = examRuleSchema.parse({ questionCount: 10 })
    expect(parsed).toMatchObject({
      questionCount: 10,
      difficultyMin: 1,
      difficultyMax: 5,
      includeSubcategories: true,
      tagIds: [],
    })
  })

  it('defaults to including sub-categories', () => {
    // "Food Safety questions" means the tree, not only the parent node — which
    // is what a chef means when they pick a category.
    expect(examRuleSchema.parse({ questionCount: 1 }).includeSubcategories).toBe(true)
  })

  it('rejects a backwards difficulty range with a readable message', () => {
    const result = examRuleSchema.safeParse({ questionCount: 5, difficultyMin: 4, difficultyMax: 2 })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].message).toContain('backwards')
    }
  })

  it('requires a question count — a rule without one asks for nothing', () => {
    expect(examRuleSchema.safeParse({}).success).toBe(false)
  })

  it('refuses a zero or negative count', () => {
    expect(examRuleSchema.safeParse({ questionCount: 0 }).success).toBe(false)
    expect(examRuleSchema.safeParse({ questionCount: -3 }).success).toBe(false)
  })

  it('accepts the seeded category ids', () => {
    // dbId(), not z.uuid(): the seed's fixed ids are not RFC 4122 compliant and
    // strict uuid validation would reject every one. See src/lib/db/id.ts.
    const result = examRuleSchema.safeParse({
      questionCount: 5,
      categoryId: '00000000-0000-0000-0000-00000000f001',
    })
    expect(result.success).toBe(true)
  })
})

describe('exam settings', () => {
  it('defaults to a dual-verification official exam', () => {
    const parsed = examSchema.parse({ title: 'Food Safety Level 1' })
    expect(parsed).toMatchObject({
      kind: 'official',
      verificationMode: 'dual',
      maxAttempts: 1,
      shuffleQuestions: true,
      shuffleOptions: true,
      timezone: 'Asia/Kolkata',
    })
  })

  it('leaves paperMode unset so the action can derive it from kind', () => {
    // Deriving here would bake the default into the payload and make an
    // explicit override indistinguishable from a default.
    expect(examSchema.parse({ title: 'Anything' }).paperMode).toBeUndefined()
  })

  it('rejects a title too short to identify an exam', () => {
    expect(examSchema.safeParse({ title: 'x' }).success).toBe(false)
  })

  it('refuses a pass mark outside 0–100', () => {
    expect(examSchema.safeParse({ title: 'Valid title', passMarkPercent: 140 }).success).toBe(false)
  })
})

describe('assignments', () => {
  it('accepts a group target with an id', () => {
    const result = assignmentSchema.safeParse({
      targetKind: 'outlet',
      targetId: '00000000-0000-0000-0000-00000000a001',
    })
    expect(result.success).toBe(true)
  })

  it('accepts a role target with a key', () => {
    // A KEY, not a uuid: has_role() reads keys from the JWT, so a uuid would
    // force the visibility policy to join user_roles per candidate row.
    const result = assignmentSchema.safeParse({ targetKind: 'role', targetRole: 'employee' })
    expect(result.success).toBe(true)
  })

  it('rejects a role target given a uuid', () => {
    const result = assignmentSchema.safeParse({
      targetKind: 'role',
      targetId: '00000000-0000-0000-0000-00000000e004',
    })
    expect(result.success).toBe(false)
  })

  it('rejects a group target given a role key', () => {
    const result = assignmentSchema.safeParse({ targetKind: 'outlet', targetRole: 'employee' })
    expect(result.success).toBe(false)
  })

  it('rejects a target with neither', () => {
    expect(assignmentSchema.safeParse({ targetKind: 'department' }).success).toBe(false)
  })
})
