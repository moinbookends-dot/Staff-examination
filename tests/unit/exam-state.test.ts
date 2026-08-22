import { describe, it, expect } from 'vitest'
import { examState, percentOf, type ExamWindow } from '@/lib/exams/state'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * examState() against public.exam_state().
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE TABLE BELOW IS THE ONE THE SQL WAS VERIFIED WITH.                     ║
 * ║                                                                           ║
 * ║ 0064 defines the same rule in plpgsql, because SQL callers cannot reach   ║
 * ║ the TypeScript and the list screens cannot reach the function. Two copies ║
 * ║ of a rule drift unless something holds them together; this is that thing. ║
 * ║                                                                           ║
 * ║ Verified directly against the database on 10 Aug 2026:                    ║
 * ║                                                                           ║
 * ║   draft         → draft        cancelled     → cancelled                  ║
 * ║   completed     → closed       before start  → scheduled                  ║
 * ║   in window     → live         past deadline → closed                     ║
 * ║   no dates      → live                                                    ║
 * ║                                                                           ║
 * ║ If this file is ever changed, run the same cases against exam_state() and ║
 * ║ change 0064 to match. Changing only one of them is the bug it prevents.   ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */

const NOW = new Date('2026-08-10T12:00:00Z')
const hours = (n: number) => new Date(NOW.getTime() + n * 3_600_000).toISOString()

const exam = (over: Partial<ExamWindow>): ExamWindow => ({
  status: 'scheduled',
  opensAt: null,
  closesAt: null,
  ...over,
})

describe('examState mirrors public.exam_state()', () => {
  const cases: [string, ExamWindow, string][] = [
    ['draft', exam({ status: 'draft' }), 'draft'],
    ['cancelled', exam({ status: 'cancelled' }), 'cancelled'],
    ['completed', exam({ status: 'completed' }), 'closed'],
    ['archived', exam({ status: 'archived' }), 'closed'],
    ['before start', exam({ opensAt: hours(24), closesAt: hours(48) }), 'scheduled'],
    ['in window', exam({ opensAt: hours(-1), closesAt: hours(1) }), 'live'],
    ['past deadline', exam({ opensAt: hours(-48), closesAt: hours(-24) }), 'closed'],
    ['no dates', exam({}), 'live'],
  ]

  for (const [label, input, expected] of cases) {
    it(`${label} → ${expected}`, () => {
      expect(examState(input, NOW)).toBe(expected)
    })
  }

  it('closes on the exact deadline, not a millisecond after', () => {
    // `now >= closes_at` in SQL. A boundary that disagreed by one tick would
    // put an exam in the live list while start_attempt refused it.
    const closesNow = exam({ opensAt: hours(-1), closesAt: NOW.toISOString() })
    expect(examState(closesNow, NOW)).toBe('closed')

    const oneMsEarlier = new Date(NOW.getTime() - 1)
    expect(examState(closesNow, oneMsEarlier)).toBe('live')
  })

  it('opens on the exact start time', () => {
    // `now < opens_at` in SQL: at exactly opens_at the exam is live.
    const opensNow = exam({ opensAt: NOW.toISOString(), closesAt: hours(1) })
    expect(examState(opensNow, NOW)).toBe('live')
    expect(examState(opensNow, new Date(NOW.getTime() - 1))).toBe('scheduled')
  })

  it('a cancelled exam stays cancelled inside its own window', () => {
    // Status wins over the dates. An exam called off at noon must not reappear
    // as "live" because its window has not lapsed yet.
    expect(
      examState(exam({ status: 'cancelled', opensAt: hours(-1), closesAt: hours(1) }), NOW),
    ).toBe('cancelled')
  })
})

describe('percentOf', () => {
  it('rounds to whole percent', () => {
    expect(percentOf(1, 3)).toBe(33)
    expect(percentOf(2, 3)).toBe(67)
  })

  it('returns 0 rather than NaN when nobody is eligible', () => {
    // An exam published but not yet assigned has an audience of zero, and
    // "NaN%" on a monitoring card is how that used to show up.
    expect(percentOf(0, 0)).toBe(0)
  })
})
