import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { dbId } from '@/lib/db/id'

/**
 * Identifier validation against the ids this project actually uses.
 *
 * THE BUG THIS EXISTS FOR: Zod 4 tightened `.uuid()` to enforce the RFC 4122
 * version and variant nibbles. Every fixed id in seed.sql looks like
 * 00000000-0000-0000-0000-00000000c001 — perfectly valid to Postgres, rejected
 * by Zod. getAppClaims() parsed the JWT's `app` claim with a schema built from
 * z.string().uuid(), so for any user in the seeded company the parse failed on
 * company_id and the helper returned DENY_ALL. Every authenticated page
 * redirected to /pending while holding a valid token.
 *
 * It survived two milestones because nothing exercised it: the RLS suite talks
 * to Postgres directly and the HTTP walkthrough never renders a page.
 *
 * The seed.sql sweep below is the part that keeps this fixed. It fails the
 * moment somebody adds a fixed id in a shape the application would reject —
 * which is the only way this class of bug comes back.
 */

const SEED = readFileSync(resolve(process.cwd(), 'supabase/seed.sql'), 'utf-8')
const UUID_LITERAL = /'([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})'/g

describe('dbId', () => {
  it('accepts the placeholder shape the seed uses', () => {
    expect(dbId().safeParse('00000000-0000-0000-0000-00000000c001').success).toBe(true)
  })

  it('accepts a real gen_random_uuid() value', () => {
    expect(dbId().safeParse('3a3372e9-b410-4920-b351-a400e5c3673b').success).toBe(true)
  })

  it('still rejects things that are not uuids', () => {
    for (const bad of ['', 'not-a-uuid', '00000000-0000-0000-0000-00000000c00', 'zzzzzzzz-0000-0000-0000-00000000c001']) {
      expect(dbId().safeParse(bad).success, `accepted ${JSON.stringify(bad)}`).toBe(false)
    }
  })

  it('is more permissive than strict uuid, which is the whole point', () => {
    // If this ever flips, z.guid() has gained version checking and dbId needs
    // its own regex.
    expect(z.uuid().safeParse('00000000-0000-0000-0000-00000000c001').success).toBe(false)
    expect(dbId().safeParse('00000000-0000-0000-0000-00000000c001').success).toBe(true)
  })
})

describe('every id in seed.sql', () => {
  const ids = [...new Set([...SEED.matchAll(UUID_LITERAL)].map((m) => m[1]))]

  it('finds ids to check', () => {
    // Guards the sweep itself: a regex that stopped matching would make the
    // test below pass vacuously.
    expect(ids.length).toBeGreaterThan(10)
  })

  it('parses with the validator the application uses', () => {
    const rejected = ids.filter((id) => !dbId().safeParse(id).success)
    expect(
      rejected,
      `seed.sql contains ids the app would reject: ${rejected.join(', ')}`,
    ).toEqual([])
  })
})
