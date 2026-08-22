import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Fixture ids must not collide across integration suites.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHY THIS EXISTS.                                                          │
 * │                                                                           │
 * │ evaluation.test.ts was written with CHEF = aaaa9999-…, which exam-draw    │
 * │ had already claimed. Each suite's beforeAll deletes the users it is about │
 * │ to create, so whichever ran second destroyed the other's chef — and the   │
 * │ symptom was a foreign key violation in exam-draw's TEARDOWN, in a suite   │
 * │ whose forty assertions all passed, on a file the change had never         │
 * │ touched. Nothing pointed at the real cause.                               │
 * │                                                                           │
 * │ Suites share one database, so ids are a namespace and this is the         │
 * │ registry. Cheap to check, and it fails in the right place with the right  │
 * │ message.                                                                  │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Shared fixtures are exempt: the seeded company, outlets, brands and roles are
 * MEANT to be referenced everywhere, and they are recognised by appearing in
 * the helpers or in seed.sql rather than by being listed again here.
 */

const root = resolve(__dirname, '../..')
const suiteDir = resolve(root, 'tests/integration')

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

function uuidsIn(path: string): Set<string> {
  if (!existsSync(path)) return new Set()
  return new Set((readFileSync(path, 'utf8').match(UUID) ?? []).map((u) => u.toLowerCase()))
}

/** Ids every suite is entitled to reference: the seeded org and the helpers. */
const shared = new Set<string>([
  ...uuidsIn(resolve(suiteDir, 'helpers/db.ts')),
  ...uuidsIn(resolve(root, 'supabase/seed.sql')),
  // The "no such row" sentinel. Several suites use it to prove a lookup 404s,
  // and it is exempt for the reason the rule exists at all: collisions matter
  // because two suites create and delete the same row. Nobody creates this one.
  '00000000-0000-0000-0000-0000000000ff',
])

describe('integration fixture ids', () => {
  const files = readdirSync(suiteDir).filter((f) => f.endsWith('.test.ts'))

  it('finds the integration suites', () => {
    expect(files.length).toBeGreaterThan(5)
  })

  it('does not reuse an id across two suites', () => {
    const owners = new Map<string, string[]>()

    for (const file of files) {
      for (const id of uuidsIn(resolve(suiteDir, file))) {
        if (shared.has(id)) continue
        owners.set(id, [...(owners.get(id) ?? []), file])
      }
    }

    const collisions = [...owners.entries()]
      .filter(([, where]) => where.length > 1)
      .map(([id, where]) => `${id} used by ${where.join(' and ')}`)

    // Named in the message, because the failure this prevents shows up
    // somewhere else entirely.
    expect(collisions, `fixture id collision:\n  ${collisions.join('\n  ')}`).toEqual([])
  })
})
