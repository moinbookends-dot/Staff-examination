/**
 * How an attempt closed, classified once for every surface.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE REASON IS THE MARKER — THERE IS NO SEPARATE "CHEATED" FLAG.           │
 * │                                                                           │
 * │ attempts.submit_reason is written exactly once, server-side, inside       │
 * │ grade_and_close_attempt, and nothing ever updates it. 'tab_switch' is     │
 * │ the one reason a closure records that the candidate left the active exam  │
 * │ — a hidden tab, a switched app, a minimised browser, a locked phone —     │
 * │ and the product treats that recorded fact as cheating. 'timer' and        │
 * │ 'sweeper' are the clock's doing, not the candidate's, and stay ordinary   │
 * │ auto-submits. 'user' and null are a real press of the Submit button.      │
 * │                                                                           │
 * │ Kept in step with the SQL side: exam_participants() in migration 0094     │
 * │ derives auto_submitted from the same list.                                │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

/** The candidate left the active exam and the closure recorded it. */
export function isCheating(reason: string | null | undefined): boolean {
  return reason === 'tab_switch'
}

/** Closed by anything other than the candidate pressing Submit. */
export function isAutoSubmitted(reason: string | null | undefined): boolean {
  return reason === 'timer' || reason === 'tab_switch' || reason === 'sweeper'
}
