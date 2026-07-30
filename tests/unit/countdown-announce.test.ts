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

/**
 * Exactly the rule in attempt-runner.tsx's tick().
 *
 * `state` mirrors the two refs the component holds across ticks.
 */
type Ticker = { announced: Set<number>; firstTick: boolean }
const ticker = (): Ticker => ({ announced: new Set(), firstTick: true })

function announce(seconds: number, state: Ticker): number | null {
  let spoken: number | null = null

  const crossed = ANNOUNCE_AT_SECONDS.filter((s) => seconds <= s && !state.announced.has(s))
  if (crossed.length > 0 && seconds > 0) {
    for (const s of crossed) state.announced.add(s)
    const nearest = Math.min(...crossed)
    // Only if crossed just now: stale by more than two seconds means the tab
    // slept or the component has just mounted, and the number would be a lie.
    if (!state.firstTick && nearest - seconds <= 2) spoken = nearest
  }

  state.firstTick = false
  return spoken
}

describe('countdown announcements', () => {
  it('says nothing before the first threshold', () => {
    const seen = ticker()
    expect(announce(1800, seen)).toBeNull()
    expect(announce(601, seen)).toBeNull()
    expect(seen.announced.size).toBe(0)
  })

  it('announces each threshold once, in order, on a machine that stays awake', () => {
    const seen = ticker()
    const said: number[] = []
    // One tick per second from eleven minutes to zero.
    for (let s = 660; s >= 0; s--) {
      const out = announce(s, seen)
      if (out !== null) said.push(out)
    }
    expect(said).toEqual([600, 300, 120, 60, 30])
  })

  /**
   * ┌─────────────────────────────────────────────────────────────────────────┐
   * │ A STALE CROSSING IS NEVER SPOKEN. THIS IS THE WHOLE POINT.              │
   * │                                                                         │
   * │ A phone that sleeps at ten minutes and wakes at ninety seconds has      │
   * │ crossed 600, 300 and 120 while it was asleep. NONE of them is true      │
   * │ any more. The earlier version announced the nearest one — "two minutes  │
   * │ remaining" to somebody with ninety seconds — which is better than "ten  │
   * │ minutes" and still a lie.                                               │
   * │                                                                         │
   * │ Silence is recoverable. A wrong number is acted on.                     │
   * └─────────────────────────────────────────────────────────────────────────┘
   */
  it('says nothing about a threshold crossed while the tab was asleep', () => {
    const seen = ticker()
    expect(announce(700, seen)).toBeNull() // asleep before any threshold
    expect(announce(90, seen)).toBeNull() // wakes with 90s left, says nothing
    // …but banks them, so they cannot be replayed one per second afterwards.
    expect(announce(89, seen)).toBeNull()
    expect(announce(88, seen)).toBeNull()
    // …and the next genuine crossing still works.
    expect(announce(60, seen)).toBe(60)
  })

  /**
   * The finding that produced this rule. Resume on /my-exams remounts the
   * runner mid-paper, and a fresh mount starts with nothing banked — so every
   * threshold above the time now left looks uncrossed.
   */
  it('says nothing on the first tick after mounting mid-exam', () => {
    const seen = ticker()
    // Resume with 5:01 left. The old rule said "10 minutes remaining".
    expect(announce(301, seen)).toBeNull()
    expect(seen.announced.has(600)).toBe(true)
    // The next real crossing is still announced correctly.
    expect(announce(300, seen)).toBe(300)
  })

  it('never repeats a threshold', () => {
    const seen = ticker()
    announce(301, seen) // first tick, silent
    expect(announce(300, seen)).toBe(300)
    expect(announce(300, seen)).toBeNull()
    expect(announce(299, seen)).toBeNull()
  })

  /**
   * A four-minute quiz has less time in total than the largest threshold. It
   * must not open by announcing more time than the paper contains.
   */
  it('does not announce a threshold longer than the exam itself', () => {
    const seen = ticker()
    expect(announce(240, seen)).toBeNull() // first tick of a 4-minute paper
    expect(seen.announced.has(600)).toBe(true)
    expect(seen.announced.has(300)).toBe(true)
    // Only thresholds genuinely inside the paper are ever spoken.
    expect(announce(120, seen)).toBe(120)
  })

  it('says nothing once the time is up — the dialog handles that', () => {
    const seen = ticker()
    expect(announce(0, seen)).toBeNull()
    expect(announce(-5, seen)).toBeNull()
  })
})
