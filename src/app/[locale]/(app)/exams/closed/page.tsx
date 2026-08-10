import { requirePermission } from '@/lib/auth/guards'
import { ExamSection } from '@/components/exams/exam-section'
import { loadExamsByState, withParticipation } from '@/server/exams/live'

/**
 * /exams/closed — finished, and the record of what happened.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ PARTICIPATION IS LOADED HERE TOO, AND IT IS THE POINT OF THE PAGE.       │
 * │                                                                           │
 * │ On the live list the ratio says "go and chase people". Here the same      │
 * │ numbers are the outcome — how many of the people who were asked actually  │
 * │ sat it — and that is the question a closed-exam history exists to answer. │
 * │                                                                           │
 * │ Average score and pass rate are NOT on the card. They belong to the       │
 * │ exam's own page, where the per-employee table is, and computing them per  │
 * │ card would mean expanding every audience on every render of this list.    │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export default async function ClosedExamsPage() {
  await requirePermission('exams.read')

  const buckets = await loadExamsByState()

  const counts = {
    live: buckets.live.length,
    scheduled: buckets.scheduled.length,
    closed: buckets.closed.length,
  }

  const rows = await withParticipation(buckets.closed)

  return <ExamSection current="closed" rows={rows} counts={counts} />
}
