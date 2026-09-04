/**
 * How an attempt closed, classified once for every surface.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE REASON IS THE MARKER — THERE IS NO SEPARATE "CHEATED" FLAG.           │
 * │                                                                           │
 * │ attempts.submit_reason is written exactly once, server-side, inside       │
 * │ grade_and_close_attempt, and nothing ever updates it. Two reasons record  │
 * │ that the candidate left the active exam, one per browser signal:          │
 * │                                                                           │
 * │  · 'tab_switch' — the page went HIDDEN: another tab, another app, Home,   │
 * │    recents, a locked phone, a minimised browser.                          │
 * │  · 'focus_loss' — the page stayed visible but the WINDOW lost focus and   │
 * │    did not get it back within the runner's grace: an Android floating     │
 * │    window (a Meet bubble over the exam), split-screen interaction, a      │
 * │    second browser window worked in on top.                                │
 * │                                                                           │
 * │ Both are cheating. 'timer' and 'sweeper' are the clock's doing, not the   │
 * │ candidate's, and stay ordinary auto-submits. 'user' and null are a real   │
 * │ press of the Submit button.                                               │
 * │                                                                           │
 * │ Kept in step with the SQL side: exam_participants() in migration 0094     │
 * │ derives auto_submitted from the same list.                                │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

/** Every reason that records the candidate leaving the active exam. */
export const CHEATING_REASONS = ['tab_switch', 'focus_loss'] as const

/** The candidate left the active exam and the closure recorded it. */
export function isCheating(reason: string | null | undefined): boolean {
  return reason === 'tab_switch' || reason === 'focus_loss'
}

/** Closed by anything other than the candidate pressing Submit. */
export function isAutoSubmitted(reason: string | null | undefined): boolean {
  return isCheating(reason) || reason === 'timer' || reason === 'sweeper'
}
