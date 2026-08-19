import { describe, expect, it } from 'vitest'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { applyOrder, planImportOrder } from '../../scripts/lib/import-order.mjs'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The re-import ordering that 0054's dedupe index makes necessary.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHAT THESE TESTS ARE ACTUALLY PROTECTING.                                │
 * │                                                                           │
 * │ unique (brand_id, difficulty, lower(btrim(question))) where locale='en'   │
 * │ is a PARTIAL unique index, so it cannot be deferred and is evaluated      │
 * │ after every statement — including the statements inside                   │
 * │ bank_import_commit's own transaction.                                     │
 * │                                                                           │
 * │ So a revision that moves an existing sentence onto a different externalId │
 * │ cannot be applied in file order: for one statement both the old owner and │
 * │ the new claimant hold it. That is what failed the Hard re-import on       │
 * │ 18 Aug 2026 at row 412, four batches in.                                  │
 * │                                                                           │
 * │ The unit under test decides the order. Getting it wrong does not throw    │
 * │ here — it throws 23505 partway through a live import — which is why the   │
 * │ planner also replays its own plan and refuses rather than reporting a     │
 * │ number nobody checks.                                                     │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Keys are opaque strings. In production Postgres computes them with the
 * index's own expression; nothing here depends on how they are spelled.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** `{ externalId, key }` from a compact `id: key` map, in insertion order. */
const items = (spec: Record<string, string>) =>
  Object.entries(spec).map(([externalId, key]) => ({ externalId, key }))

/** Current ownership: `key → externalId`. */
const owned = (spec: Record<string, string>) => new Map(Object.entries(spec))

describe('planImportOrder', () => {
  describe('a file that needs no reordering', () => {
    it('leaves an already-safe file exactly as written', () => {
      // Every question keeps its own text: the commonest re-import by far.
      const plan = planImportOrder(
        items({ A: 'a', B: 'b', C: 'c' }),
        owned({ a: 'A', b: 'B', c: 'C' }),
      )

      expect(plan.ok).toBe(true)
      expect(plan.edges).toHaveLength(0)
      expect(plan.reordered).toBe(0)
      expect(plan.order).toEqual(['A', 'B', 'C'])
    })

    it('is idempotent — re-running a settled import moves nothing', () => {
      const file = items({ A: 'a', B: 'b', C: 'c' })
      const first = planImportOrder(file, owned({ a: 'A', b: 'B', c: 'C' }))

      // The bank now matches the file. Running it again must be a no-op plan.
      const second = planImportOrder(file, owned({ a: 'A', b: 'B', c: 'C' }))

      expect(first.order).toEqual(second.order)
      expect(second.reordered).toBe(0)
      expect(second.edges).toHaveLength(0)
    })

    it('creates no edge for a question whose text is entirely new', () => {
      // Nothing holds 'z', so there is nobody to wait for.
      const plan = planImportOrder(items({ A: 'z' }), owned({ a: 'A' }))

      expect(plan.ok).toBe(true)
      expect(plan.edges).toHaveLength(0)
      expect(plan.reordered).toBe(0)
    })
  })

  describe('rename collisions', () => {
    it('puts the releasing question before the claiming one', () => {
      /*
       * The 18 Aug shape, minimised: A wants the sentence B still holds, and
       * the file lists A first. Applied in file order this is a 23505.
       */
      const plan = planImportOrder(
        items({ A: 'b', B: 'z' }),
        owned({ a: 'A', b: 'B' }),
      )

      expect(plan.ok).toBe(true)
      expect(plan.edges).toEqual([{ dependent: 'A', blocker: 'B' }])
      expect(plan.order).toEqual(['B', 'A'])
      expect(plan.reordered).toBe(2)
    })

    it('leaves a collision alone when the file already orders it safely', () => {
      // Same dependency, but B is already listed first — nothing to move.
      const plan = planImportOrder(
        items({ B: 'z', A: 'b' }),
        owned({ a: 'A', b: 'B' }),
      )

      expect(plan.ok).toBe(true)
      expect(plan.edges).toEqual([{ dependent: 'A', blocker: 'B' }])
      expect(plan.order).toEqual(['B', 'A'])
      expect(plan.reordered).toBe(0)
    })

    it('resolves a chain by walking it to the end first', () => {
      // A ← B ← C: C frees 'c' for B, which frees 'b' for A.
      const plan = planImportOrder(
        items({ A: 'b', B: 'c', C: 'z' }),
        owned({ a: 'A', b: 'B', c: 'C' }),
      )

      expect(plan.ok).toBe(true)
      expect(plan.edges).toHaveLength(2)
      expect(plan.order).toEqual(['C', 'B', 'A'])
    })

    it('resolves several independent chains without entangling them', () => {
      // A ← B and C ← D, interleaved in the file.
      const plan = planImportOrder(
        items({ A: 'b', C: 'd', B: 'y', D: 'z' }),
        owned({ a: 'A', b: 'B', c: 'C', d: 'D' }),
      )

      expect(plan.ok).toBe(true)
      expect(plan.edges).toHaveLength(2)
      expect(plan.order).toEqual(['B', 'A', 'D', 'C'])

      // Each blocker precedes its dependent; the chains do not interleave.
      expect(plan.order.indexOf('B')).toBeLessThan(plan.order.indexOf('A'))
      expect(plan.order.indexOf('D')).toBeLessThan(plan.order.indexOf('C'))
    })
  })

  describe('minimal movement', () => {
    it('moves only the rows a dependency forces', () => {
      /*
       * One collision buried in a settled file. Everything except the pair has
       * to keep its position — a planner that simply topologically re-sorts
       * everything would pass the collision tests and churn the whole import.
       */
      const plan = planImportOrder(
        items({ A: 'a', B: 'b', C: 'd', D: 'z', E: 'e' }),
        owned({ a: 'A', b: 'B', c: 'C', d: 'D', e: 'E' }),
      )

      expect(plan.ok).toBe(true)
      expect(plan.order).toEqual(['A', 'B', 'D', 'C', 'E'])
      expect(plan.moved.map((m) => m.externalId).sort()).toEqual(['C', 'D'])
      expect(plan.reordered).toBe(2)
    })

    it('keeps every row exactly once', () => {
      const file = items({ A: 'b', B: 'c', C: 'z', D: 'd' })
      const plan = planImportOrder(file, owned({ a: 'A', b: 'B', c: 'C', d: 'D' }))

      expect(plan.order).toHaveLength(file.length)
      expect(new Set(plan.order).size).toBe(file.length)
      expect([...plan.order].sort()).toEqual(['A', 'B', 'C', 'D'])
    })
  })

  describe('refusals — these must fail before anything is written', () => {
    it('detects a two-question swap as a cycle', () => {
      // A and B trade sentences. No single-pass order can do this.
      const plan = planImportOrder(
        items({ A: 'b', B: 'a' }),
        owned({ a: 'A', b: 'B' }),
      )

      expect(plan.ok).toBe(false)
      expect(plan.cycles).toHaveLength(1)
      expect(plan.cycles[0]).toEqual(['A', 'B', 'A'])
      expect(plan.problems.join(' ')).toMatch(/cycle/i)
    })

    it('detects a longer cycle and reports it once, not once per entry point', () => {
      const plan = planImportOrder(
        items({ A: 'b', B: 'c', C: 'a' }),
        owned({ a: 'A', b: 'B', c: 'C' }),
      )

      expect(plan.ok).toBe(false)
      expect(plan.cycles).toHaveLength(1)
      expect(plan.cycles[0]).toEqual(['A', 'B', 'C', 'A'])
    })

    it('refuses when the holder is not in the import at all', () => {
      /*
       * X holds the sentence A wants, and X is not being re-imported, so it
       * never lets go. Reordering cannot fix this one.
       */
      const plan = planImportOrder(items({ A: 'x' }), owned({ a: 'A', x: 'X' }))

      expect(plan.ok).toBe(false)
      expect(plan.problems.join(' ')).toContain('X')
      expect(plan.problems.join(' ')).toMatch(/never release/i)
    })

    it('refuses a file that contains the same English twice', () => {
      const plan = planImportOrder(items({ A: 'same', B: 'same' }), owned({}))

      expect(plan.ok).toBe(false)
      expect(plan.problems.join(' ')).toMatch(/duplicate English/i)
    })
  })

  describe('applyOrder', () => {
    it('reorders the payload to match the plan', () => {
      const rows = [
        { externalId: 'A', payload: 1 },
        { externalId: 'B', payload: 2 },
        { externalId: 'C', payload: 3 },
      ]

      expect(applyOrder(rows, ['C', 'A', 'B'])).toEqual([
        { externalId: 'C', payload: 3 },
        { externalId: 'A', payload: 1 },
        { externalId: 'B', payload: 2 },
      ])
    })

    it('carries every row through untouched', () => {
      const rows = [{ externalId: 'A' }, { externalId: 'B' }]
      const out = applyOrder(rows, ['B', 'A'])

      expect(out).toHaveLength(2)
      expect(out[0]).toBe(rows[1])
      expect(out[1]).toBe(rows[0])
    })
  })

  describe('at the scale this exists for', () => {
    it('resolves a 1,000-question shift where every stem moves one id down', () => {
      /*
       * The pathological version of the real revision: every question takes
       * its neighbour's sentence. One long chain, 999 edges, and the only
       * order that works is strictly backwards.
       */
      const size = 1000
      const file = Array.from({ length: size }, (_, i) => ({
        externalId: `q${i}`,
        key: i === size - 1 ? 'fresh' : `k${i + 1}`,
      }))
      const ownership = new Map(
        Array.from({ length: size }, (_, i) => [`k${i}`, `q${i}`] as const),
      )

      const plan = planImportOrder(file, ownership)

      expect(plan.ok).toBe(true)
      expect(plan.cycles).toHaveLength(0)
      expect(plan.edges).toHaveLength(size - 1)
      expect(plan.order).toHaveLength(size)
      expect(plan.order[0]).toBe(`q${size - 1}`)
      expect(plan.order.at(-1)).toBe('q0')
    })

    it('refuses a 1,000-question rotation, which is one enormous cycle', () => {
      const size = 1000
      const file = Array.from({ length: size }, (_, i) => ({
        externalId: `q${i}`,
        key: `k${(i + 1) % size}`,
      }))
      const ownership = new Map(
        Array.from({ length: size }, (_, i) => [`k${i}`, `q${i}`] as const),
      )

      const plan = planImportOrder(file, ownership)

      expect(plan.ok).toBe(false)
      expect(plan.cycles).toHaveLength(1)
    })
  })

  /*
   * ┌─────────────────────────────────────────────────────────────────────────┐
   * │ THE REAL HARD REVISION, WHEN THE INTERMEDIATES ARE ON DISK.             │
   * │                                                                         │
   * │ _aiko-hard.json and _aiko-hard.prev.json are gitignored — derived from  │
   * │ proprietary source and regenerated on demand — so this cannot be a hard │
   * │ requirement. It runs for whoever has them and reports why it did not    │
   * │ otherwise, rather than passing silently and looking like coverage.      │
   * │                                                                         │
   * │ The bank was, at the time of the failed import, exactly prev's content, │
   * │ so prev doubles as the ownership fixture.                               │
   * └─────────────────────────────────────────────────────────────────────────┘
   */
  const NEXT = resolve('_aiko-hard.json')
  const PREV = resolve('_aiko-hard.prev.json')
  const haveFixtures = existsSync(NEXT) && existsSync(PREV)

  describe.skipIf(!haveFixtures)('the 18 Aug 2026 Hard revision', () => {
    /*
     * An APPROXIMATION of lower(btrim(x)), for fixture-building only. btrim()
     * strips spaces and not tabs, which is exactly why production asks
     * Postgres instead of doing this.
     */
    const key = (s: string) => s.replace(/^ +| +$/g, '').toLowerCase()
    const read = (p: string) =>
      JSON.parse(readFileSync(p, 'utf-8')).questions as {
        externalId: string
        en: { question: string }
      }[]

    it('is resolvable, and needs real reordering to be so', () => {
      const next = read(NEXT)
      const prev = read(PREV)

      const ownership = new Map(prev.map((q) => [key(q.en.question), q.externalId]))
      const file = next.map((q) => ({ externalId: q.externalId, key: key(q.en.question) }))

      const plan = planImportOrder(file, ownership)

      expect(plan.ok).toBe(true)
      expect(plan.cycles).toHaveLength(0)
      expect(plan.order).toHaveLength(1030)
      expect(new Set(plan.order).size).toBe(1030)

      // If either of these ever reaches zero the fixture has drifted and this
      // test has stopped exercising the thing it was written for.
      expect(plan.edges.length).toBeGreaterThan(0)
      expect(plan.reordered).toBeGreaterThan(0)
    })

    it('would have collided in file order at aiko-hard-0412', () => {
      /*
       * The regression itself. Replaying the file AS WRITTEN must still break,
       * on the same row, or the fixture no longer reproduces the incident.
       */
      const next = read(NEXT)
      const prev = read(PREV)

      const holds = new Map(prev.map((q) => [key(q.en.question), q.externalId]))
      const heldBy = new Map(prev.map((q) => [q.externalId, key(q.en.question)]))

      let firstCollision: { at: number; incoming: string; owner: string } | null = null

      next.forEach((q, i) => {
        if (firstCollision) return
        const k = key(q.en.question)
        const owner = holds.get(k)
        if (owner !== undefined && owner !== q.externalId) {
          firstCollision = { at: i + 1, incoming: q.externalId, owner }
          return
        }
        const previous = heldBy.get(q.externalId)
        if (previous !== undefined) holds.delete(previous)
        holds.set(k, q.externalId)
        heldBy.set(q.externalId, k)
      })

      expect(firstCollision).not.toBeNull()
      expect(firstCollision!.incoming).toBe('aiko-hard-0412')
      expect(firstCollision!.owner).toBe('aiko-hard-0413')
      // Batch size is 100, so row 412 lands in the fifth batch.
      expect(Math.ceil(firstCollision!.at / 100)).toBe(5)
    })
  })
})
