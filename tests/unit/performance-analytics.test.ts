import { describe, it, expect } from 'vitest'
import {
  computeTrend,
  summarise,
  filterHistory,
  sortHistory,
  completedChronological,
  TREND_MINIMUM,
  type HistoryRow,
} from '@/lib/analytics/performance'
import { filterParticipants, sortParticipants, participantCounts } from '@/lib/analytics/participants'
import type { ParticipantRow } from '@/server/exams/live'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Performance analytics: computed, never invented.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ The spec these shipped under says "do not invent the trend" and "do not   ║
 * ║ generate fake points". A pure function cannot invent anything its inputs  ║
 * ║ do not contain — these tests pin that the inputs are also never padded,   ║
 * ║ reordered into a lie, or defaulted into fake certainty (a pass rate of    ║
 * ║ zero for someone who has sat nothing is a defamation, not a default).     ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */

let seq = 0
function row(percent: number | null, over: Partial<HistoryRow> = {}): HistoryRow {
  seq += 1
  return {
    attempt_id: `a${seq}`,
    exam_id: `e${seq}`,
    exam_title: over.exam_title ?? `Exam ${seq}`,
    attempt_no: 1,
    started_at: over.started_at ?? `2026-08-${String(seq).padStart(2, '0')}T09:00:00Z`,
    submitted_at:
      'submitted_at' in over ? (over.submitted_at ?? null) : `2026-08-${String(seq).padStart(2, '0')}T10:00:00Z`,
    minutes: 30,
    score: percent === null ? null : percent / 5,
    max_score: 20,
    percent,
    passed: over.passed ?? (percent !== null ? percent >= 33 : null),
    ...over,
  }
}

describe('trend', () => {
  it('says insufficient below the minimum, whatever the shape', () => {
    seq = 0
    const rising = [row(10), row(40), row(90)]
    expect(rising.length).toBeLessThan(TREND_MINIMUM)
    expect(computeTrend(rising)).toBe('insufficient')
  })

  it('calls a clear rise improving', () => {
    seq = 0
    expect(computeTrend([row(40), row(45), row(70), row(80)])).toBe('improving')
  })

  it('calls a clear fall declining', () => {
    seq = 0
    expect(computeTrend([row(90), row(85), row(50), row(40)])).toBe('declining')
  })

  it('calls noise around a level stable', () => {
    seq = 0
    expect(computeTrend([row(70), row(68), row(72), row(69)])).toBe('stable')
  })

  it('judges chronology, not array order', () => {
    // The same attempts arrive newest-first from the RPC; the trend must not
    // read a rise as a fall because of transport order.
    seq = 0
    // Chronologically rising (seq dates ascend with creation order)…
    const rows = [row(40), row(45), row(70), row(80)]
    // …handed over shuffled, as an RPC ordering newest-first would.
    const shuffled = [rows[3], rows[0], rows[2], rows[1]]
    expect(computeTrend(shuffled)).toBe('improving')
  })

  it('ignores incomplete attempts entirely', () => {
    seq = 0
    const rows = [row(40), row(45), row(70), row(80), row(null), row(null)]
    expect(computeTrend(rows)).toBe('improving')
  })
})

describe('summary', () => {
  it('reports null rates for an empty record — never zero', () => {
    const s = summarise([])
    expect(s.passRate).toBeNull()
    expect(s.avgPercent).toBeNull()
    expect(s.bestPercent).toBeNull()
    expect(s.trend).toBe('insufficient')
  })

  it('computes the figures from the rows alone', () => {
    seq = 0
    const s = summarise([row(90), row(50), row(20), row(null)])
    expect(s.totalAttempts).toBe(4)
    expect(s.completed).toBe(3)
    expect(s.passed).toBe(2)
    expect(s.failed).toBe(1)
    expect(s.passRate).toBe(66.7)
    expect(s.avgPercent).toBe(53.3)
    expect(s.bestPercent).toBe(90)
    expect(s.worstPercent).toBe(20)
  })

  it('orders the chart data oldest-first regardless of input order', () => {
    seq = 0
    const a = row(10), b = row(90)
    const done = completedChronological([b, a])
    expect(done.map((r) => r.percent)).toEqual([10, 90])
  })
})

describe('history filters', () => {
  it('searches the exam title, case-insensitively', () => {
    seq = 0
    const rows = [row(50, { exam_title: 'Food Safety' }), row(60, { exam_title: 'Hygiene' })]
    expect(filterHistory(rows, { search: 'food' })).toHaveLength(1)
  })

  it('filters pass and fail without conflating null', () => {
    seq = 0
    const rows = [row(90), row(20), row(null)]
    expect(filterHistory(rows, { result: 'passed' })).toHaveLength(1)
    expect(filterHistory(rows, { result: 'failed' })).toHaveLength(1)
    // The unfinished attempt is neither — filtering must not sweep it in.
    expect(filterHistory(rows, { result: 'all' })).toHaveLength(3)
  })

  it('treats the "to" date as the end of that day, not its midnight', () => {
    seq = 0
    const r = row(50, { submitted_at: '2026-08-10T18:30:00Z' })
    expect(filterHistory([r], { to: '2026-08-10' })).toHaveLength(1)
    expect(filterHistory([r], { to: '2026-08-09' })).toHaveLength(0)
    expect(filterHistory([r], { from: '2026-08-11' })).toHaveLength(0)
  })

  it('sorts by score and by date', () => {
    seq = 0
    const rows = [row(50), row(90), row(20)]
    expect(sortHistory(rows, 'highest')[0].percent).toBe(90)
    expect(sortHistory(rows, 'lowest')[0].percent).toBe(20)
    expect(sortHistory(rows, 'oldest')[0].percent).toBe(50)
    expect(sortHistory(rows, 'newest')[0].percent).toBe(20)
  })
})

// ─────────────────────────────────────────────────────────────────────────────

function participant(over: Partial<ParticipantRow>): ParticipantRow {
  return {
    employeeId: over.employeeId ?? 'u1',
    fullName: over.fullName ?? 'Asha Cook',
    email: over.email ?? 'asha@bookends.co',
    department: 'Cook',
    outlet: 'Aiko — Outlet 1',
    startedAt: null,
    submittedAt: null,
    expiresAt: null,
    state: 'not_started',
    autoSubmitted: false,
    submitReason: null,
    attemptId: null,
    attemptNo: null,
    answeredN: 0,
    questionN: 20,
    lastActivity: null,
    score: null,
    maxScore: null,
    passed: null,
    released: false,
    ...over,
  }
}

describe('participant filters', () => {
  const rows = [
    participant({ employeeId: 'a', fullName: 'Asha', state: 'in_progress' }),
    participant({ employeeId: 'b', fullName: 'Bina', state: 'released', passed: true, score: 18, maxScore: 20 }),
    participant({ employeeId: 'c', fullName: 'Chirag', state: 'released', passed: false, score: 4, maxScore: 20, autoSubmitted: true }),
    participant({ employeeId: 'd', fullName: 'Divya', email: 'divya@bookends.co', state: 'not_started' }),
  ]

  it('searches name and email together', () => {
    expect(filterParticipants(rows, { search: 'divya' })).toHaveLength(1)
    expect(filterParticipants(rows, { search: 'bookends.co' })).toHaveLength(4)
  })

  it('filters each status, and pass/fail as outcomes', () => {
    expect(filterParticipants(rows, { status: 'in_progress' })).toHaveLength(1)
    expect(filterParticipants(rows, { status: 'passed' })).toHaveLength(1)
    expect(filterParticipants(rows, { status: 'failed' })).toHaveLength(1)
    expect(filterParticipants(rows, { status: 'auto_submitted' })[0].employeeId).toBe('c')
  })

  it('never mutates or drops rows from the source', () => {
    const before = rows.length
    filterParticipants(rows, { status: 'passed' })
    sortParticipants(rows, 'highest')
    expect(rows).toHaveLength(before)
  })

  it('sorts highest score first, treating unscored as last', () => {
    const sorted = sortParticipants(rows, 'highest')
    expect(sorted[0].employeeId).toBe('b')
    expect(sorted[1].employeeId).toBe('c')
  })
})

describe('participant counts — the tabs and the tiles share these', () => {
  const rows = [
    participant({ employeeId: '1', state: 'not_started' }),
    participant({ employeeId: '2', state: 'not_started' }),
    participant({ employeeId: '3', state: 'in_progress', attemptId: 'a3' }),
    participant({ employeeId: '4', state: 'released', passed: true, attemptId: 'a4' }),
    participant({ employeeId: '5', state: 'released', passed: false, autoSubmitted: true, attemptId: 'a5' }),
    participant({ employeeId: '6', state: 'expired', attemptId: 'a6' }),
    participant({ employeeId: '7', state: 'submitted', attemptId: 'a7' }),
  ]

  it('splits the three groups the way the spec defines them', () => {
    const c = participantCounts(rows)
    expect(c).toEqual({ all: 7, attempted: 4, live: 1, notAttempted: 2, passed: 1, failed: 1 })
  })

  it('counts an auto-submitted attempt as attempted, never as its own group', () => {
    const c = participantCounts(rows)
    // employee 5 is auto-submitted AND failed AND attempted — three facts,
    // one person, no double-counted group.
    expect(c.attempted + c.live + c.notAttempted).toBe(c.all)
  })

  it('an expired attempt is attempted — it existed and ended', () => {
    expect(filterParticipants(rows, { status: 'attempted' }).map((r) => r.employeeId)).toEqual(
      ['4', '5', '6', '7'],
    )
  })

  it('the attempted filter and the count agree by construction', () => {
    expect(filterParticipants(rows, { status: 'attempted' })).toHaveLength(
      participantCounts(rows).attempted,
    )
  })

  it('a cheating closure changes the chip, never the arithmetic', () => {
    // The verdict lives in submit_reason and is rendered as a badge; the
    // person still attempted, still failed, still sums into the same groups.
    // A cheated attempt that vanished from the counts would understate how
    // many people sat the paper.
    const cheated = rows.map((r) =>
      r.employeeId === '5' ? { ...r, submitReason: 'tab_switch' } : r,
    )
    expect(participantCounts(cheated)).toEqual(participantCounts(rows))
    expect(filterParticipants(cheated, { status: 'attempted' })).toHaveLength(
      filterParticipants(rows, { status: 'attempted' }).length,
    )
  })
})
