import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  sortIssues,
  blockingIssues,
  canPublish,
  remedyFor,
  ISSUE_REMEDY,
  type HealthIssue,
} from '@/lib/exams/health'

/**
 * Exam Health rendering helpers.
 *
 * The checks themselves are SQL and are tested against a real database in
 * tests/integration/exam-draw.test.ts — they have to be, because the whole
 * point is that they run the real draw.
 *
 * What is worth testing here is the seam: the codes the migration can emit and
 * the remedies this layer offers must not drift apart. A code with no remedy
 * renders as a bare problem with no suggested fix, which is how a chef ends up
 * stuck on a blocking issue they cannot interpret.
 */

const MIGRATION = readFileSync(
  resolve(process.cwd(), 'supabase/migrations/20260727140000_0014_exams.sql'),
  'utf-8',
)

/** Every `select 'code', 'severity'` the validator can return. */
const EMITTED = [
  ...MIGRATION.matchAll(/select\s+'([a-z_]+\.[a-z_]+)'(?:::text)?,\s*'(blocking|advisory)'/g),
].map((m) => ({ code: m[1], severity: m[2] }))

const issue = (code: string, severity: 'blocking' | 'advisory'): HealthIssue => ({
  code,
  severity,
  section_id: null,
  rule_id: null,
  message: code,
  detail: {},
})

describe('the SQL validator and this layer agree', () => {
  it('finds the codes in the migration', () => {
    // Guards the sweep itself: a regex that stopped matching would make every
    // assertion below pass vacuously.
    expect(EMITTED.length).toBeGreaterThanOrEqual(9)
  })

  it('offers a remedy for every code the validator can emit', () => {
    const missing = EMITTED.filter((e) => !ISSUE_REMEDY[e.code]).map((e) => e.code)
    expect(missing, `codes with no remedy: ${missing.join(', ')}`).toEqual([])
  })

  it('has no remedies for codes that no longer exist', () => {
    const codes = new Set(EMITTED.map((e) => e.code))
    const orphaned = Object.keys(ISSUE_REMEDY).filter((c) => !codes.has(c))
    expect(orphaned, `remedies for dead codes: ${orphaned.join(', ')}`).toEqual([])
  })

  it('keeps the blocking set exactly as agreed', () => {
    // Anything that makes the paper unanswerable or wrong blocks; anything that
    // is a judgement call warns. Moving a code between these lists changes what
    // a chef is allowed to publish, so it should be a deliberate edit here too.
    const blocking = EMITTED.filter((e) => e.severity === 'blocking').map((e) => e.code).sort()
    expect(blocking).toEqual([
      'marks.zero',
      'media.missing',
      'paper.duplicate',
      'rule.short',
      'structure.no_rules',
      'structure.no_sections',
    ])

    const advisory = EMITTED.filter((e) => e.severity === 'advisory').map((e) => e.code).sort()
    expect(advisory).toEqual(['difficulty.narrow', 'duration.mismatch', 'translation.missing'])
  })
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
