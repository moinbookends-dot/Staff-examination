import type { ParticipantRow } from '@/server/exams/live'

/**
 * Filtering, searching and sorting the monitoring table — pure, for the same
 * reason item-selection.ts is: the component has no test reach, and the rule
 * that matters (a filter narrows what is SHOWN, never what was FETCHED, so
 * clearing it cannot lose anyone) deserves an assertion.
 */

export type ParticipantStatusFilter =
  | 'all'
  | 'attempted'
  | 'not_started'
  | 'in_progress'
  | 'submitted'
  | 'released'
  | 'expired'
  | 'auto_submitted'
  | 'passed'
  | 'failed'

/**
 * The three groups the monitoring spec is built around, counted once so the
 * tabs and the summary tiles can never disagree:
 *
 *   not attempted — assigned but no attempt row (state 'not_started')
 *   live          — an attempt in progress right now
 *   attempted     — an attempt that ENDED, however it ended: submitted,
 *                   released, or expired. An auto-submitted attempt is
 *                   attempted; the auto flag is an annotation, not a group.
 */
export function participantCounts(rows: readonly ParticipantRow[]) {
  const notAttempted = rows.filter((r) => r.state === 'not_started').length
  const live = rows.filter((r) => r.state === 'in_progress').length
  return {
    all: rows.length,
    attempted: rows.length - notAttempted - live,
    live,
    notAttempted,
    passed: rows.filter((r) => r.passed === true).length,
    failed: rows.filter((r) => r.passed === false).length,
  }
}

export interface ParticipantFilter {
  search?: string
  status?: ParticipantStatusFilter
}

export type ParticipantSort =
  | 'name'
  | 'started'
  | 'submitted'
  | 'activity'
  | 'highest'
  | 'lowest'

export function filterParticipants(
  rows: readonly ParticipantRow[],
  f: ParticipantFilter,
): ParticipantRow[] {
  const needle = (f.search ?? '').trim().toLowerCase()
  const status = f.status ?? 'all'

  return rows.filter((r) => {
    if (needle) {
      const hay = `${r.fullName ?? ''} ${r.email}`.toLowerCase()
      if (!hay.includes(needle)) return false
    }
    switch (status) {
      case 'all': return true
      case 'attempted':
        return r.state !== 'not_started' && r.state !== 'in_progress'
      // Auto-submit cuts across states: an expired attempt was auto-closed
      // too. The filter answers "who did not press Submit themselves".
      case 'auto_submitted': return r.autoSubmitted
      case 'passed': return r.passed === true
      case 'failed': return r.passed === false
      default: return r.state === status
    }
  })
}

export function sortParticipants(
  rows: readonly ParticipantRow[],
  sort: ParticipantSort,
): ParticipantRow[] {
  const at = (v: string | null) => (v ? Date.parse(v) : 0)
  const pc = (r: ParticipantRow) =>
    r.score !== null && r.maxScore ? r.score / r.maxScore : -1
  const next = [...rows]
  switch (sort) {
    case 'name':
      return next.sort((a, b) => (a.fullName ?? a.email).localeCompare(b.fullName ?? b.email))
    case 'started': return next.sort((a, b) => at(b.startedAt) - at(a.startedAt))
    case 'submitted': return next.sort((a, b) => at(b.submittedAt) - at(a.submittedAt))
    case 'activity': return next.sort((a, b) => at(b.lastActivity) - at(a.lastActivity))
    case 'highest': return next.sort((a, b) => pc(b) - pc(a))
    case 'lowest': return next.sort((a, b) => pc(a) - pc(b))
  }
}
