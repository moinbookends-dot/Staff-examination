/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The product's exam vocabulary: draft, scheduled, live, closed, cancelled.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THIS MIRRORS public.exam_state() IN MIGRATION 0064, LINE FOR LINE.        ║
 * ║                                                                           ║
 * ║ Two copies exist because the two callers cannot share one: SQL needs it   ║
 * ║ inside release_due_results() and exam_participants(), and the list screens║
 * ║ read `exams` straight through PostgREST — where a function call cannot be ║
 * ║ put in a select without a view.                                          ║
 * ║                                                                           ║
 * ║ tests/unit/exam-state.test.ts pins the same seven cases the SQL was       ║
 * ║ verified against, so the two cannot drift silently.                      ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ DISPLAY ONLY. THIS IS NOT A GATE.                                        │
 * │                                                                           │
 * │ start_attempt() reads opens_at and closes_at itself on every call and     │
 * │ refuses outside the window. A candidate could not sit a closed exam even  │
 * │ if this function were wrong — it decides which list an exam appears in,   │
 * │ nothing more.                                                             │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** What the stored column holds. */
export type StoredExamStatus =
  | 'draft'
  | 'scheduled'
  | 'active'
  | 'completed'
  | 'archived'
  | 'cancelled'

/** What the product says. */
export type ExamState = 'draft' | 'scheduled' | 'live' | 'closed' | 'cancelled'

export const EXAM_STATES: readonly ExamState[] = [
  'draft',
  'scheduled',
  'live',
  'closed',
  'cancelled',
] as const

export interface ExamWindow {
  status: StoredExamStatus
  opensAt: string | null
  closesAt: string | null
}

/**
 * `now` is a parameter rather than a call to Date.now() so the state is a pure
 * function of its inputs — which is what makes the table in the unit test able
 * to assert anything at all.
 */
export function examState(exam: ExamWindow, now: Date = new Date()): ExamState {
  if (exam.status === 'draft') return 'draft'
  if (exam.status === 'cancelled') return 'cancelled'

  // archived and completed are both "finished with" to a candidate or a
  // monitoring screen; the distinction is administrative.
  if (exam.status === 'completed' || exam.status === 'archived') return 'closed'

  const t = now.getTime()
  if (exam.closesAt && t >= new Date(exam.closesAt).getTime()) return 'closed'
  if (exam.opensAt && t < new Date(exam.opensAt).getTime()) return 'scheduled'

  /*
   * No opening time means it opened the moment it was published — which is
   * how publish_paper_as_exam leaves it when the chef gives no start time.
   * A closing time is mandatory there, so "live forever" is not reachable
   * through the paper flow.
   */
  return 'live'
}

/** Percentage, guarding the zero-denominator that an unassigned exam produces. */
export function percentOf(part: number, whole: number): number {
  if (!whole) return 0
  return Math.round((part / whole) * 100)
}
