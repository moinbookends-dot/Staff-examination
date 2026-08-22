import { requirePermission } from '@/lib/auth/guards'
import { ExamSection } from '@/components/exams/exam-section'
import { loadExamsByState, withParticipation } from '@/server/exams/live'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * /exams/live — exams candidates can sit RIGHT NOW.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ "LIVE" IS DERIVED, NOT STORED, AND THIS PAGE IS WHY THAT MATTERS.        │
 * │                                                                           │
 * │ Nothing writes exams.status when a deadline passes — there is no pg_cron  │
 * │ on this project. If this list filtered on the stored column it would show │
 * │ exams that closed days ago as live, and it would be wrong in a way nobody │
 * │ would notice until a candidate complained.                                │
 * │                                                                           │
 * │ examState() decides instead, from the window and the clock, every render. │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * requirePermission('exams.read') and not merely a nav entry: this route is
 * reachable by typing it. An Employee holds attempts.take and not exams.read,
 * so they are refused here and use /my-exams — which shows only what they may
 * sit and none of the participation data.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export default async function LiveExamsPage() {
  await requirePermission('exams.read')

  const buckets = await loadExamsByState()

  // Counts for every tab, so the tab bar is honest before anything is clicked.
  const counts = {
    live: buckets.live.length,
    scheduled: buckets.scheduled.length,
    closed: buckets.closed.length,
  }

  // Participation is fetched for the rendered bucket only — each row is an RPC
  // that expands the exam's audience, and the other tabs are not on screen.
  const rows = await withParticipation(buckets.live)

  return <ExamSection current="live" rows={rows} counts={counts} />
}
