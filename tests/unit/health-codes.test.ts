import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ISSUE_REMEDY, remedyFor } from '../../src/lib/exams/health'

/**
 * Every code the database can emit has advice attached to it.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE GAP THIS CLOSES.                                                      │
 * │                                                                           │
 * │ remedyFor returns null for a code it does not know, and the UI renders    │
 * │ the problem with nothing under it. The screen looks finished. Nobody      │
 * │ finds out except the one person who meets that specific code and wonders  │
 * │ why this issue, alone, comes with no advice.                              │
 * │                                                                           │
 * │ Four codes were in that state when M9 began: key.missing since 0022, and  │
 * │ all three translation advisories since 0035 — one of them shipped by the  │
 * │ same commit that wrote the map it was missing from.                       │
 * │                                                                           │
 * │ So this reads the MIGRATIONS, not a hand-kept list. A list would have to  │
 * │ be updated by the same person who forgot to update the map.               │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

const MIGRATIONS = join(__dirname, '..', '..', 'supabase', 'migrations')

/**
 * Codes as they are written in SQL: `select 'code.name', 'severity', …`.
 *
 * Anchored on the severity that follows, because a bare quoted string with a
 * dot in it also matches search configurations, locales and jsonb paths — and
 * a pattern that over-matches turns this test into one that demands remedies
 * for things that are not codes.
 */
function codesInSql(): Map<string, { files: string[]; severities: Set<string> }> {
  const found = new Map<string, { files: string[]; severities: Set<string> }>()
  for (const file of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql'))) {
    const sql = readFileSync(join(MIGRATIONS, file), 'utf8')
    const pattern = /select\s+'([a-z_]+\.[a-z_]+)'(?:::text)?\s*,\s*'(blocking|advisory)'/g
    for (const match of sql.matchAll(pattern)) {
      const [, code, severity] = match
      const entry = found.get(code) ?? { files: [], severities: new Set<string>() }
      entry.files.push(file)
      entry.severities.add(severity)
      found.set(code, entry)
    }
  }
  return found
}

describe('exam health codes', () => {
  const emitted = codesInSql()

  it('finds the codes in the migrations at all', () => {
    // The control for every assertion below. A regex that silently stopped
    // matching would make an empty set trivially satisfy "all are covered".
    expect(emitted.size).toBeGreaterThan(10)
    expect([...emitted.keys()]).toContain('structure.no_sections')
    expect([...emitted.keys()]).toContain('quality.misrated')
    expect([...emitted.keys()]).toContain('bank.no_bloom')
  })

  it('has a remedy for every code the database can emit', () => {
    const missing = [...emitted.entries()]
      .filter(([code]) => !(code in ISSUE_REMEDY))
      .map(([code, { files }]) => `${code} (emitted by ${[...new Set(files)].join(', ')})`)

    expect(missing, `codes with no entry in ISSUE_REMEDY:\n  ${missing.join('\n  ')}`).toEqual([])
  })

  /**
   * Severity decides what a chef is ALLOWED to publish: canPublish refuses on
   * any blocking row. Moving a code between the two lists changes that, so it
   * should require a deliberate edit here as well as in SQL.
   *
   * M9's four statistical codes are all advisory on purpose. A chef may
   * knowingly run a paper containing an ugly question, and blocking on a
   * statistic would teach people to retire questions to get past the gate.
   */
  it('blocks only on what makes a paper unanswerable or wrong', () => {
    const blocking = [...emitted.entries()]
      .filter(([, { severities }]) => severities.has('blocking'))
      .map(([code]) => code)
      .sort()

    expect(blocking).toEqual([
      'bank.thin',
      'key.missing',
      'marks.zero',
      'media.missing',
      'paper.duplicate',
      'rule.short',
      'structure.no_rules',
      'structure.no_sections',
    ])
  })

  it('never gives one code two severities', () => {
    // A code redefined in a later migration with a different severity would
    // silently change the publish gate, and the reproduce-the-whole-function
    // pattern 0035 and 0046 both use makes that a real way to slip.
    const conflicted = [...emitted.entries()]
      .filter(([, { severities }]) => severities.size > 1)
      .map(([code, { severities }]) => `${code}: ${[...severities].join('/')}`)
    expect(conflicted).toEqual([])
  })

  it('has no remedy for a code the database cannot emit', () => {
    // The other direction. A remedy for a code that no longer exists is dead
    // text that reads as current, and it is how a map drifts once a check is
    // renamed rather than removed.
    const orphans = Object.keys(ISSUE_REMEDY).filter((code) => !emitted.has(code))
    expect(orphans, `remedies for codes nothing emits: ${orphans.join(', ')}`).toEqual([])
  })

  it('gives advice that is actually advice', () => {
    for (const [code, remedy] of Object.entries(ISSUE_REMEDY)) {
      // Long enough to say what to do. A one-word remedy is the shape of an
      // entry added to silence this test.
      expect(remedy.length, code).toBeGreaterThan(20)
      expect(remedy.trim(), code).toBe(remedy)
    }
  })

  it('resolves through remedyFor, and still returns null for nonsense', () => {
    for (const code of emitted.keys()) {
      expect(remedyFor(code), code).not.toBeNull()
    }
    expect(remedyFor('not.a.code')).toBeNull()
  })

  /**
   * The specific failure that let four codes ship unremedied: the old check
   * read migration 0014 alone, and exam_health has been replaced wholesale
   * twice since — by 0035 and again by 0046. Codes added in those files were
   * invisible to it, so neither direction of the parity check could see them.
   */
  it('reads the migrations that REPLACED exam_health, not just the one that made it', () => {
    const files = new Set([...emitted.values()].flatMap((e) => e.files))
    expect([...files].some((f) => f.includes('0046'))).toBe(true)
    expect([...files].some((f) => f.includes('0035'))).toBe(true)
    expect([...files].some((f) => f.includes('0045'))).toBe(true)
  })
})
