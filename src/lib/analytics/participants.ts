import type { ParticipantRow } from '@/server/exams/live'

/**
 * Filtering, searching and sorting the monitoring table — pure, for the same
 * reason item-selection.ts is: the component has no test reach, and the rule
 * that matters (a filter narrows what is SHOWN, never what was FETCHED, so
 * clearing it cannot lose anyone) deserves an assertion.
 */

export type ParticipantStatusFilter =
  | 'all'
  | 'not_started'
  | 'in_progress'
  | 'submitted'
  | 'released'
  | 'expired'
  | 'auto_submitted'
  | 'passed'
  | 'failed'

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
