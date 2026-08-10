import { requirePermission } from '@/lib/auth/guards'
import { ExamSection } from '@/components/exams/exam-section'
import { loadExamsByState, withParticipation } from '@/server/exams/live'

/**
 * /exams/upcoming — published, assigned, and not open yet.
 *
 * The section that exists so a chef can find an exam BEFORE it starts, which
 * is the only window in which its configuration can still be corrected: once
 * it opens, 0016's immutability trigger freezes everything but the closing
 * time, the status and the audience.
 *
 * Participation is still loaded, and the numbers are not zero-by-definition:
 * `eligible` says how many people the assignment reaches, which is exactly
 * what somebody wants to check before the exam goes live.
 */
export default async function UpcomingExamsPage() {
  await requirePermission('exams.read')

  const buckets = await loadExamsByState()

  const counts = {
    live: buckets.live.length,
    scheduled: buckets.scheduled.length,
    closed: buckets.closed.length,
  }

  const rows = await withParticipation(buckets.scheduled)

  return <ExamSection current="scheduled" rows={rows} counts={counts} />
}
