import { describe, it, expect } from 'vitest'
import {
  DEFAULT_DAILY_CAP,
  MAX_ATTEMPTS,
  drainOnce,
  type DrainDeps,
  type OutboxRow,
} from '@/lib/notifications/drain'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The drain, exercised through a fake transport.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ WHAT MATTERS HERE IS WHAT HAPPENS WHEN SENDING FAILS. A queue that        ║
 * ║ delivers on the happy path but loses a row on a provider blip is worse    ║
 * ║ than no queue at all, because the loss is silent — nobody learns of it    ║
 * ║ until somebody asks why they never got their result.                      ║
 * ║                                                                           ║
 * ║ So the failure cases are the bulk of this file: a failed row keeps its     ║
 * ║ error, stays eligible, and gives up at exactly the boundary the queue      ║
 * ║ index uses. No sooner, so a blip retries; no later, so a permanently bad   ║
 * ║ address stops burning a metered quota.                                    ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */

function row(over: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: over.id ?? 'row-1',
    to_email: over.to_email ?? 'chef@bookends.co',
    to_user_id: over.to_user_id ?? 'user-1',
    subject: over.subject ?? 'You have a new exam: Knife skills',
    template: over.template ?? 'exam-assigned',
    payload: over.payload ?? {},
    priority: over.priority ?? 4,
    scheduled_for: over.scheduled_for ?? '2026-08-01T00:00:00.000Z',
    attempts: over.attempts ?? 0,
  }
}

interface Harness {
  deps: DrainDeps
  sent: string[]
  marked: string[]
  failures: Array<{ id: string; attempts: number; error: string }>
  claimedLimits: number[]
}

function harness(rows: OutboxRow[], opts: { sentToday?: number; fail?: string } = {}): Harness {
  const h: Harness = {
    sent: [],
    marked: [],
    failures: [],
    claimedLimits: [],
    deps: {
      async claim(limit) {
        h.claimedLimits.push(limit)
        return rows.slice(0, limit)
      },
      async sentToday() {
        return opts.sentToday ?? 0
      },
      async recipient() {
        return { locale: 'en', name: 'Asha' }
      },
      async send({ to }) {
        if (opts.fail) return { ok: false, error: opts.fail }
        h.sent.push(to)
        return { ok: true }
      },
      async markSent(id) {
        h.marked.push(id)
      },
      async markFailed(id, attempts, error) {
        h.failures.push({ id, attempts, error })
      },
      appUrl: () => 'https://bookends-exam.onrender.com',
    },
  }
  return h
}

describe('sending', () => {
  it('sends each due row and marks it', async () => {
    const h = harness([row({ id: 'a' }), row({ id: 'b', to_email: 'hr@bookends.co' })])
    const out = await drainOnce(h.deps)
    expect(out.sent).toBe(2)
    expect(out.failed).toBe(0)
    expect(h.marked).toEqual(['a', 'b'])
  })

  it('marks a row sent only after the provider accepted it', async () => {
    const h = harness([row({ id: 'a' })], { fail: 'unverified sender' })
    await drainOnce(h.deps)
    expect(h.marked).toEqual([])
  })
})

describe('when the provider refuses', () => {
  it('records the error against the row rather than dropping it', async () => {
    const h = harness([row({ id: 'a' })], { fail: 'domain not verified' })
    const out = await drainOnce(h.deps)
    expect(out.failed).toBe(1)
    expect(h.failures[0]).toMatchObject({ id: 'a', attempts: 1, error: 'domain not verified' })
  })

  it('counts the attempt so a permanently bad row eventually stops', async () => {
    const h = harness([row({ id: 'a', attempts: 3 })], { fail: 'nope' })
    await drainOnce(h.deps)
    expect(h.failures[0].attempts).toBe(4)
  })

  it('reaches the give-up boundary at exactly the queue index threshold', async () => {
    /*
     * email_outbox_queue_idx filters `attempts < 5`. If the code gave up at a
     * different number, rows would either be retried forever or abandoned while
     * still eligible — the index and the code have to agree.
     */
    const h = harness([row({ id: 'a', attempts: MAX_ATTEMPTS - 1 })], { fail: 'nope' })
    await drainOnce(h.deps)
    expect(h.failures[0].attempts).toBe(MAX_ATTEMPTS)
  })

  it('keeps going after one bad address rather than failing the run', async () => {
    // One unroutable colleague must not stop everybody else's mail.
    const rows = [row({ id: 'a' }), row({ id: 'b' }), row({ id: 'c' })]
    const h = harness(rows, { fail: 'bad address' })
    const out = await drainOnce(h.deps)
    expect(out.failed).toBe(3)
    expect(out.failures).toHaveLength(3)
  })

  it('reports every failure so the caller can log them', async () => {
    const h = harness([row({ id: 'a' })], { fail: 'rate limited' })
    const out = await drainOnce(h.deps)
    expect(out.failures[0]).toMatchObject({ id: 'a', to: 'chef@bookends.co' })
  })
})

describe('the daily ceiling', () => {
  it('sends nothing once the cap is already spent', async () => {
    const h = harness([row({ id: 'a' })], { sentToday: DEFAULT_DAILY_CAP })
    const out = await drainOnce(h.deps)
    expect(out.sent).toBe(0)
    expect(h.sent).toEqual([])
  })

  it('reports what it held back rather than failing silently', async () => {
    // Delayed, not dropped — the whole reason 0007 built a queue.
    const h = harness([row({ id: 'a' }), row({ id: 'b' })], { sentToday: DEFAULT_DAILY_CAP })
    const out = await drainOnce(h.deps)
    expect(out.skippedByCap).toBe(2)
    expect(out.remainingToday).toBe(0)
  })

  it('claims only what remains of the cap, not the full batch', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => row({ id: `r${i}` }))
    const h = harness(rows, { sentToday: DEFAULT_DAILY_CAP - 3 })
    await drainOnce(h.deps, { batch: 25 })
    expect(h.claimedLimits[0]).toBe(3)
  })

  it('never exceeds the cap even when the batch is larger', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => row({ id: `r${i}` }))
    const h = harness(rows, { sentToday: 95 })
    const out = await drainOnce(h.deps, { batch: 25 })
    expect(out.sent).toBeLessThanOrEqual(5)
  })

  it('respects an explicit batch below the remaining headroom', async () => {
    const rows = Array.from({ length: 40 }, (_, i) => row({ id: `r${i}` }))
    const h = harness(rows)
    await drainOnce(h.deps, { batch: 5 })
    expect(h.claimedLimits[0]).toBe(5)
  })
})

describe('dry run', () => {
  it('sends nothing and marks nothing', async () => {
    const h = harness([row({ id: 'a' }), row({ id: 'b' })])
    const out = await drainOnce(h.deps, { dryRun: true })
    expect(h.sent).toEqual([])
    expect(h.marked).toEqual([])
    expect(h.failures).toEqual([])
    expect(out.attempted).toBe(0)
  })

  it('previews who would receive what, so it can be checked before a live send', async () => {
    const h = harness([row({ id: 'a', to_email: 'asha@bookends.co' })])
    const out = await drainOnce(h.deps, { dryRun: true })
    expect(out.previewed).toEqual([
      {
        id: 'a',
        to: 'asha@bookends.co',
        subject: 'You have a new exam: Knife skills',
        locale: 'en',
      },
    ])
  })
})

describe('addresses that can never receive mail', () => {
  /*
   * Every seed script, demo fixture and check run in this repo enqueues to
   * reserved domains. Before this rule, the first live drain would have made
   * 54 doomed API calls in one burst — which is what a provider's abuse
   * detection is built to notice.
   */
  it.each([
    'sample-employee@example.com',
    'chef@example.org',
    'someone@example.net',
    'render-cand-123@bookends-test.local',
    'admin@bookends.test',
    'nobody@somewhere.invalid',
  ])('never attempts %s', async (to) => {
    const h = harness([row({ id: 'a', to_email: to })])
    await drainOnce(h.deps)
    expect(h.sent).toEqual([])
  })

  it('gives it no retries, because a reserved domain cannot become routable', async () => {
    const h = harness([row({ id: 'a', to_email: 'x@example.com' })])
    await drainOnce(h.deps)
    expect(h.failures[0].attempts).toBe(MAX_ATTEMPTS)
    expect(h.failures[0].error).toMatch(/reserved domain/i)
  })

  it('still delivers to the routable addresses in the same batch', async () => {
    const h = harness([
      row({ id: 'bad', to_email: 'x@example.com' }),
      row({ id: 'good', to_email: 'asha@bookends.co' }),
    ])
    const out = await drainOnce(h.deps)
    expect(h.sent).toEqual(['asha@bookends.co'])
    expect(out.sent).toBe(1)
    expect(out.failed).toBe(1)
  })

  it('does not mistake a real domain that merely contains the word', async () => {
    // "example" inside a hostname is not the reserved example.com.
    const h = harness([row({ id: 'a', to_email: 'chef@examplefoods.co.uk' })])
    await drainOnce(h.deps)
    expect(h.sent).toEqual(['chef@examplefoods.co.uk'])
  })

  it('touches nothing during a dry run', async () => {
    const h = harness([row({ id: 'a', to_email: 'x@example.com' })])
    await drainOnce(h.deps, { dryRun: true })
    expect(h.failures).toEqual([])
  })
})
