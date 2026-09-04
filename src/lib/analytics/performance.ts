/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A candidate's performance, computed — never invented.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ EVERY NUMBER HERE DERIVES FROM ATTEMPT ROWS PASSED IN. There is no        ║
 * ║ default, no seed, and no "looks about right" fallback — the instruction   ║
 * ║ this feature shipped under says "do not invent the trend", and the way    ║
 * ║ to guarantee that is a pure function with a test suite.                   ║
 * ║                                                                           ║
 * ║ THE TREND RULE, stated so a human can check it against the chart:         ║
 * ║ order the completed attempts chronologically, split in half, compare the  ║
 * ║ mean percent of the halves. Newer half ≥5 points up → improving; ≥5       ║
 * ║ points down → declining; otherwise stable. Fewer than four completed      ║
 * ║ attempts → not enough data, said in those words, because a "trend" drawn  ║
 * ║ through three points is an anecdote wearing a suit.                       ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface HistoryRow {
  attempt_id: string
  exam_id: string
  exam_title: string
  attempt_no: number | null
  started_at: string | null
  submitted_at: string | null
  minutes: number | null
  score: number | null
  max_score: number | null
  percent: number | null
  passed: boolean | null
  /** attempts.submit_reason — 'tab_switch' marks the attempt as cheating. */
  submit_reason?: string | null
}

export type Trend = 'improving' | 'declining' | 'stable' | 'insufficient'

/** Fewer completed attempts than this and no trend claim is honest. */
export const TREND_MINIMUM = 4
/** Mean percentage-point shift that separates a trend from noise. */
export const TREND_THRESHOLD = 5

/** Rows that actually finished with a measurable outcome, oldest first. */
export function completedChronological(rows: readonly HistoryRow[]): HistoryRow[] {
  return rows
    .filter((r) => r.percent !== null && r.submitted_at !== null)
    .sort((a, b) => Date.parse(a.submitted_at!) - Date.parse(b.submitted_at!))
}

export function computeTrend(rows: readonly HistoryRow[]): Trend {
  const done = completedChronological(rows)
  if (done.length < TREND_MINIMUM) return 'insufficient'

  const mid = Math.floor(done.length / 2)
  const mean = (xs: HistoryRow[]) =>
    xs.reduce((sum, r) => sum + (r.percent as number), 0) / xs.length

  const older = mean(done.slice(0, mid))
  const newer = mean(done.slice(done.length - mid))

  if (newer - older >= TREND_THRESHOLD) return 'improving'
  if (older - newer >= TREND_THRESHOLD) return 'declining'
  return 'stable'
}

export interface PerformanceSummary {
  totalAttempts: number
  completed: number
  passed: number
  failed: number
  /** Null when nothing completed — never zero, which would read as total failure. */
  passRate: number | null
  avgPercent: number | null
  bestPercent: number | null
  worstPercent: number | null
  trend: Trend
}

export function summarise(rows: readonly HistoryRow[]): PerformanceSummary {
  const done = completedChronological(rows)
  const percents = done.map((r) => r.percent as number)
  const passed = done.filter((r) => r.passed === true).length
  const failed = done.filter((r) => r.passed === false).length

  const round1 = (n: number) => Math.round(n * 10) / 10

  return {
    totalAttempts: rows.length,
    completed: done.length,
    passed,
    failed,
    passRate: done.length > 0 ? round1((passed / done.length) * 100) : null,
    avgPercent: percents.length > 0 ? round1(percents.reduce((a, b) => a + b, 0) / percents.length) : null,
    bestPercent: percents.length > 0 ? Math.max(...percents) : null,
    worstPercent: percents.length > 0 ? Math.min(...percents) : null,
    trend: computeTrend(rows),
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// History filtering and sorting — the controls above the table and the chart.
// Pure, so the chart and the table filter through the same function and cannot
// disagree about which attempts are in view.
// ─────────────────────────────────────────────────────────────────────────────

export interface HistoryFilter {
  search?: string
  result?: 'passed' | 'failed' | 'all'
  from?: string | null
  to?: string | null
}

export type HistorySort = 'newest' | 'oldest' | 'highest' | 'lowest'

export function filterHistory(rows: readonly HistoryRow[], f: HistoryFilter): HistoryRow[] {
  const needle = (f.search ?? '').trim().toLowerCase()
  const from = f.from ? Date.parse(f.from) : null
  // `to` is a calendar day; the whole day belongs inside the range.
  const to = f.to ? Date.parse(f.to) + 24 * 60 * 60 * 1000 - 1 : null

  return rows.filter((r) => {
    if (needle && !r.exam_title.toLowerCase().includes(needle)) return false
    if (f.result === 'passed' && r.passed !== true) return false
    if (f.result === 'failed' && r.passed !== false) return false
    const at = r.submitted_at ? Date.parse(r.submitted_at) : null
    if (from !== null && (at === null || at < from)) return false
    if (to !== null && (at === null || at > to)) return false
    return true
  })
}

export function sortHistory(rows: readonly HistoryRow[], sort: HistorySort): HistoryRow[] {
  const at = (r: HistoryRow) => (r.submitted_at ? Date.parse(r.submitted_at) : 0)
  const pc = (r: HistoryRow) => r.percent ?? -1
  const next = [...rows]
  switch (sort) {
    case 'newest': return next.sort((a, b) => at(b) - at(a))
    case 'oldest': return next.sort((a, b) => at(a) - at(b))
    case 'highest': return next.sort((a, b) => pc(b) - pc(a))
    case 'lowest': return next.sort((a, b) => pc(a) - pc(b))
  }
}
