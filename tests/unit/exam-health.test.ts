import { describe, it, expect } from 'vitest'
import {
  sortIssues,
  blockingIssues,
  canPublish,
  remedyFor,
  type HealthIssue,
} from '@/lib/exams/health'

/**
 * Exam Health rendering helpers.
 *
 * The checks themselves are SQL and are tested against a real database in
 * tests/integration/exam-draw.test.ts — they have to be, because the whole
 * point is that they run the real draw.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE CODE/REMEDY PARITY CHECKS THAT USED TO LIVE HERE HAVE MOVED TO        │
 * │ tests/unit/health-codes.test.ts, AND THEY WERE WRONG.                     │
 * │                                                                           │
 * │ They read exactly one file — 0014 — and exam_health has been replaced     │
 * │ wholesale twice since, by 0035 and again by 0046. So the sweep was        │
 * │ measuring a function the database no longer runs.                         │
 * │                                                                           │
 * │ That is not a hypothetical. It is why key.missing (0022) and all three of │
 * │ 0035's translation advisories sat in production with NO REMEDY for a      │
 * │ milestone or more while a green test claimed otherwise — the codes were   │
 * │ invisible to the regex, so neither direction of the check could see them. │
 * │                                                                           │
 * │ The replacement reads every migration in the directory. A test pinned to  │
 * │ one filename cannot survive a function being redefined in another.        │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * What remains here is what belongs here: how this layer sorts and gates.
 */

const issue = (code: string, severity: 'blocking' | 'advisory'): HealthIssue => ({
  code,
  severity,
  section_id: null,
  rule_id: null,
  message: code,
  detail: {},
})

describe('presentation', () => {
  it('puts blocking issues first, then sorts stably by code', () => {
    // A report that reshuffles on every refresh is one people stop reading.
    const sorted = sortIssues([
      issue('duration.mismatch', 'advisory'),
      issue('rule.short', 'blocking'),
      issue('difficulty.narrow', 'advisory'),
      issue('marks.zero', 'blocking'),
    ])
    expect(sorted.map((i) => i.code)).toEqual([
      'marks.zero',
      'rule.short',
      'difficulty.narrow',
      'duration.mismatch',
    ])
  })

  it('does not mutate the array it was given', () => {
    const input = [issue('duration.mismatch', 'advisory'), issue('rule.short', 'blocking')]
    sortIssues(input)
    expect(input[0].code).toBe('duration.mismatch')
  })

  it('allows publishing over warnings but not over blockers', () => {
    expect(canPublish([issue('difficulty.narrow', 'advisory')])).toBe(true)
    expect(canPublish([issue('duration.mismatch', 'advisory')])).toBe(true)
    expect(canPublish([])).toBe(true)
    expect(canPublish([issue('rule.short', 'blocking')])).toBe(false)
    expect(
      canPublish([issue('difficulty.narrow', 'advisory'), issue('marks.zero', 'blocking')]),
    ).toBe(false)
  })

  it('extracts only the blockers', () => {
    const issues = [issue('difficulty.narrow', 'advisory'), issue('rule.short', 'blocking')]
    expect(blockingIssues(issues).map((i) => i.code)).toEqual(['rule.short'])
  })

  it('returns null for an unknown code rather than throwing', () => {
    expect(remedyFor('nonsense.code')).toBeNull()
    expect(remedyFor('rule.short')).toContain('Widen the rule')
  })
})
