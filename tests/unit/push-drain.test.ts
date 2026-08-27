import { describe, it, expect } from 'vitest'
import {
  buildPayload,
  drainPushOnce,
  type PushDeps,
  type PushableNotification,
  type Subscription,
} from '@/lib/notifications/push'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The push drain, through a fake transport.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE PROPERTY THAT MATTERS MOST: pushed_at means SETTLED, not delivered.   ║
 * ║ A row must be stamped exactly once whether the person had three phones,   ║
 * ║ one dead endpoint, or no device at all — because an unstamped row is      ║
 * ║ rescanned on every tick forever, and a double-stamped one was never       ║
 * ║ possible to observe. The bell still holds every message regardless.       ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */

const APP = 'https://performix.example'

function note(over: Partial<PushableNotification> = {}): PushableNotification {
  return {
    id: over.id ?? 'n1',
    user_id: over.user_id ?? 'u1',
    title: over.title ?? 'A new exam has been assigned to you',
    body: over.body ?? 'Knife skills',
    // `in`, not `??` — an explicit null IS the case under test.
    link: 'link' in over ? (over.link ?? null) : '/exams/e1',
  }
}

function sub(id: string): Subscription {
  return { id, endpoint: `https://push.example/${id}`, p256dh: 'k', auth: 'a' }
}

interface Harness {
  deps: PushDeps
  sent: Array<{ subId: string; payload: string }>
  pushed: string[][]
  deleted: string[]
  failures: string[]
  ok: string[]
}

function harness(
  rows: PushableNotification[],
  subsByUser: Record<string, Subscription[]>,
  opts: { failWith?: (subId: string) => { status?: number } | null } = {},
): Harness {
  const h: Harness = { sent: [], pushed: [], deleted: [], failures: [], ok: [], deps: null! }
  h.deps = {
    async claim(limit) {
      return rows.slice(0, limit)
    },
    async subscriptionsFor(userId) {
      // Honour deletions mid-run, as the real store would.
      return (subsByUser[userId] ?? []).filter((s) => !h.deleted.includes(s.id))
    },
    async localeFor() {
      return 'gu'
    },
    async send(s, payload) {
      const fail = opts.failWith?.(s.id)
      if (fail) return { ok: false, status: fail.status, error: 'refused' }
      h.sent.push({ subId: s.id, payload })
      return { ok: true }
    },
    async markPushed(ids) {
      h.pushed.push(ids)
    },
    async markSubscriptionOk(id) {
      h.ok.push(id)
    },
    async deleteSubscription(id) {
      h.deleted.push(id)
    },
    async countFailure(id) {
      h.failures.push(id)
    },
    appUrl: () => APP,
  }
  return h
}

describe('delivery', () => {
  it('sends one push per device the person has', async () => {
    const h = harness([note()], { u1: [sub('s1'), sub('s2')] })
    const out = await drainPushOnce(h.deps)
    expect(out.delivered).toBe(2)
    expect(h.sent.map((s) => s.subId)).toEqual(['s1', 's2'])
  })

  it('settles the row exactly once', async () => {
    const h = harness([note()], { u1: [sub('s1')] })
    await drainPushOnce(h.deps)
    expect(h.pushed).toEqual([['n1']])
  })

  it('settles a row even when the person has no device at all', async () => {
    // Leaving it unstamped would rescan it on every tick forever.
    const h = harness([note()], {})
    const out = await drainPushOnce(h.deps)
    expect(out.usersWithNoDevice).toBe(1)
    expect(h.pushed).toEqual([['n1']])
  })

  it('settles a row even when every send failed — the bell still has it', async () => {
    const h = harness([note()], { u1: [sub('s1')] }, { failWith: () => ({ status: 500 }) })
    const out = await drainPushOnce(h.deps)
    expect(out.failed).toBe(1)
    expect(h.pushed).toEqual([['n1']])
    expect(h.failures).toEqual(['s1'])
  })
})

describe('dead endpoints', () => {
  it.each([404, 410])('deletes the subscription the push service says is gone (%i)', async (status) => {
    const h = harness([note()], { u1: [sub('dead')] }, { failWith: () => ({ status }) })
    const out = await drainPushOnce(h.deps)
    expect(h.deleted).toEqual(['dead'])
    expect(out.deadSubscriptionsRemoved).toBe(1)
    // Dead is not failed: the counter is for flakiness, not funerals.
    expect(h.failures).toEqual([])
  })

  it('stops sending to a dead endpoint within the same run', async () => {
    // Two rows for the same person; the endpoint dies on the first.
    const h = harness(
      [note({ id: 'n1' }), note({ id: 'n2' })],
      { u1: [sub('dead'), sub('live')] },
      { failWith: (id) => (id === 'dead' ? { status: 410 } : null) },
    )
    const out = await drainPushOnce(h.deps)
    expect(out.delivered).toBe(2) // 'live' twice — 'dead' was dropped after n1
    expect(h.deleted).toEqual(['dead'])
  })

  it('a plain failure does not delete anything', async () => {
    const h = harness([note()], { u1: [sub('s1')] }, { failWith: () => ({ status: 429 }) })
    await drainPushOnce(h.deps)
    expect(h.deleted).toEqual([])
    expect(h.failures).toEqual(['s1'])
  })
})

describe('the payload', () => {
  it('carries title, body, and a link in the recipient’s own language', () => {
    const p = JSON.parse(buildPayload(note(), 'gu', APP))
    expect(p.title).toBe('A new exam has been assigned to you')
    expect(p.body).toBe('Knife skills')
    expect(p.link).toBe(`${APP}/gu/exams/e1`)
  })

  it('falls back to the dashboard when the row has no link', () => {
    const p = JSON.parse(buildPayload(note({ link: null }), 'hi', APP))
    expect(p.link).toBe(`${APP}/hi/dashboard`)
  })

  it('survives a missing app URL with a relative link', () => {
    const p = JSON.parse(buildPayload(note(), 'en', null))
    expect(p.link).toBe('/en/exams/e1')
  })

  it('tags per notification row, so a re-send replaces rather than stacks', () => {
    const a = JSON.parse(buildPayload(note({ id: 'x' }), 'en', APP))
    const b = JSON.parse(buildPayload(note({ id: 'y' }), 'en', APP))
    expect(a.tag).not.toBe(b.tag)
  })
})

describe('an empty queue', () => {
  it('does nothing and stamps nothing', async () => {
    const h = harness([], { u1: [sub('s1')] })
    const out = await drainPushOnce(h.deps)
    expect(out.settled).toBe(0)
    expect(h.pushed).toEqual([])
    expect(h.sent).toEqual([])
  })
})
