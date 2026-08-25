import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
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

describe('no strict uuid validator on database-read ids', () => {
  /*
   * The trap in src/lib/db/id.ts has now bitten TWICE: getAppClaims() (every
   * seeded user bounced to /pending with a valid token) and then
   * approveRegistration (selecting a real outlet answered "Select an
   * outlet."). Both times the code compiled, the tests passed, and only a
   * person clicking the real page hit it — because strict z.uuid() rejects
   * the seeded 00000000-…-00000000a001 ids that Postgres happily stores.
   *
   * So: scan the source for strict uuid validators. Entries come OFF this
   * allowlist as call sites migrate to dbId(); none should ever be added.
   * Every listed occurrence validates a value the APPLICATION minted with
   * gen_random_uuid()/crypto.randomUUID — never a seeded fixture id — which
   * is the one legitimate use the doctrine in id.ts leaves open.
   */
  const ALLOWED = new Set([
    'src/lib/questions/schemas.ts', // mediaId — minted by upload, always v4
    'src/server/actions/papers.ts', // topic rows from own RPC, gen_random_uuid
    'src/server/papers/availability.ts', // item/topic pool rows, gen_random_uuid
    'src/server/papers/repository.ts', // draw/save rows, gen_random_uuid
  ])

  it('finds no new strict uuid() call sites', () => {
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (/\.(ts|tsx)$/.test(entry.name)) {
          // Line-wise, skipping comments — half the codebase name-checks
          // z.uuid() in comments explaining why NOT to use it, and flagging
          // the warnings would teach people to delete them.
          const offending = readFileSync(full, 'utf8')
            .split('\n')
            .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
            .some((line) => /z\.string\(\)\.uuid\(|z\.uuid\(/.test(line))
          if (offending) {
            hits.push(full.replaceAll('\\', '/').replace(/^.*?src\//, 'src/'))
          }
        }
      }
    }
    walk(resolve(__dirname, '../../src'))

    const strays = hits.filter((h) => !ALLOWED.has(h) && !h.endsWith('lib/db/id.ts'))
    expect(strays, `use dbId() from src/lib/db/id.ts instead — see its header:\n  ${strays.join('\n  ')}`).toEqual([])
  })
})
