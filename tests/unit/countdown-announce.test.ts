import { describe, it, expect } from 'vitest'

/**
 * The exam runner's time announcements.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHY THIS IS A UNIT TEST AND NOT A COMMENT.                                │
 * │                                                                           │
 * │ A screen-reader user's only warning that time is running out is this      │
 * │ selection rule. It is four lines of code with an off-by-one that is       │
 * │ invisible on a machine that never sleeps — which is every machine a       │
 * │ developer tests on, and not the phone in a pocket during a shift.         │
 * │                                                                           │
 * │ The first draft used `.find()` over a descending list and returned the    │
 * │ FIRST match. On a tab that slept from ten minutes to ninety seconds that  │
 * │ announced "ten minutes remaining" — the largest crossed threshold — to    │
 * │ somebody with ninety seconds left. Nothing in the app could have caught   │
 * │ it: the page renders, the timer displays correctly, and the announcement  │
 * │ is invisible unless you are listening to it.                              │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Kept in lockstep with attempt-runner.tsx by hand. The runner cannot be
 * imported here — it is a client component that pulls in next-intl, the format
 * registry and server actions — so this reproduces the rule exactly and the
 * comment above each is the contract.
 */

const ANNOUNCE_AT_SECONDS = [600, 300, 120, 60, 30]

/** Exactly the rule in attempt-runner.tsx's tick(). */
function announce(seconds: number, announced: Set<number>): number | null {
  const crossed = ANNOUNCE_AT_SECONDS.filter((s) => seconds <= s && !announced.has(s))
  if (crossed.length === 0 || seconds <= 0) return null
  for (const s of crossed) announced.add(s)
  return Math.min(...crossed)
}

describe('countdown announcements', () => {
  it('says nothing before the first threshold', () => {
    const seen = new Set<number>()
    expect(announce(1800, seen)).toBeNull()
    expect(announce(601, seen)).toBeNull()
    expect(seen.size).toBe(0)
  })

  it('announces each threshold once, in order, on a machine that stays awake', () => {
    const seen = new Set<number>()
    const said: number[] = []
    // One tick per second from eleven minutes to zero.
    for (let s = 660; s >= 0; s--) {
      const out = announce(s, seen)
      if (out !== null) said.push(out)
    }
    expect(said).toEqual([600, 300, 120, 60, 30])
  })

  /**
   * The bug. A phone that sleeps at ten minutes and wakes at ninety seconds
   * must be told about ninety seconds, not about ten minutes.
   */
  it('announces the CLOSEST crossed threshold after the tab has slept', () => {
    const seen = new Set<number>()
    expect(announce(700, seen)).toBeNull() // asleep before any threshold
    expect(announce(90, seen)).toBe(120) // wakes with 90s left
  })

  it('does not replay the thresholds it slept through, one per second', () => {
    const seen = new Set<number>()
    announce(90, seen) // crosses 600, 300 and 120 at once
    // The very next tick must be silent, not "five minutes remaining".
    expect(announce(89, seen)).toBeNull()
    expect(announce(88, seen)).toBeNull()
    // …until a genuinely new threshold is reached.
    expect(announce(60, seen)).toBe(60)
  })

  it('never repeats a threshold', () => {
    const seen = new Set<number>()
    expect(announce(300, seen)).toBe(300)
    expect(announce(300, seen)).toBeNull()
    expect(announce(299, seen)).toBeNull()
  })

  /**
   * A five-minute practice quiz starts below two of the thresholds. It must not
   * open by announcing "ten minutes remaining" to somebody who has five.
   */
  it('does not announce a threshold longer than the exam itself', () => {
    const seen = new Set<number>()
    // First tick of a 5-minute paper.
    expect(announce(300, seen)).toBe(300)
    expect(seen.has(600)).toBe(true) // consumed, so it can never be said later
  })

  it('says nothing once the time is up — the dialog handles that', () => {
    const seen = new Set<number>()
    expect(announce(0, seen)).toBeNull()
    expect(announce(-5, seen)).toBeNull()
  })
})
