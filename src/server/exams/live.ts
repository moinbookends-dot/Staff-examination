import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { requirePermission } from '@/lib/auth/guards'
import { can } from '@/lib/auth/claims'
import { examState, percentOf, type ExamState, type StoredExamStatus } from '@/lib/exams/state'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Live, upcoming and closed exams, and who has sat them.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ PAPER-BACKED EXAMS ONLY.                                                  ║
 * ║                                                                           ║
 * ║ Every query here filters `paper_id not null`. The legacy rule-drawn exams ║
 * ║ still exist and still work through /exams, but they are a different       ║
 * ║ product with different validation, and mixing them into the live screens  ║
 * ║ would put an exam with no deadline into a list whose whole organising     ║
 * ║ idea is the deadline.                                                     ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * RLS does the row filtering — `exams_read_manage` scopes to the caller's
 * company. These functions add the STATE filter and the counts, and re-check
 * the permission because a page rendering is not authorisation for a read.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface LiveExamRow {
  id: string
  title: string
  paperNo: number | null
  paperId: string | null
  state: ExamState
  opensAt: string | null
  closesAt: string | null
  durationMinutes: number
  questionCount: number | null
  totalMarks: number | null
  passMarkPercent: number
  resultsRelease: 'immediate' | 'on_close'
  /** Null until participation is loaded — the list pages fill these in. */
  eligible: number
  notStarted: number
  inProgress: number
  submitted: number
  released: number
  attemptPercent: number
  submittedPercent: number
}

interface ExamRecord {
  id: string
  title: string
  status: StoredExamStatus
  opens_at: string | null
  closes_at: string | null
  duration_minutes: number
  question_count: number | null
  total_marks: number | null
  pass_mark_percent: number
  results_release: 'immediate' | 'on_close'
  paper_id: string | null
}

/**
 * Every paper-backed exam the caller may see, already bucketed by state.
 *
 * One query, then partitioned in memory. Three round trips filtered by date
 * would have to repeat the window arithmetic in SQL that examState() already
 * expresses, and the two would drift.
 */
export async function loadExamsByState(): Promise<Record<ExamState, LiveExamRow[]>> {
  await requirePermission('exams.read')

  const supabase = await createClient()

  /*
   * Results that have become due are released before anything is counted.
   *
   * This project has no pg_cron (see the box on release_due_results in 0064),
   * so the read is what makes a result appear. Doing it here rather than in
   * each page means every route that shows a count shows a settled one.
   *
   * A failure is deliberately not fatal: not releasing a result is a delay,
   * while refusing to render the monitoring screen because of it would be an
   * outage. It is surfaced in the server log by Supabase either way.
   */
  /*
   * ┌───────────────────────────────────────────────────────────────────────────┐
   * │ RUN ALONGSIDE THE READ, NOT BEFORE IT. ~120ms SAVED PER RENDER.          │
   * │                                                                           │
   * │ These were sequential — release, wait, then read — which on this project  │
   * │ costs a full extra round trip (measured median 120ms to ap-southeast-1)   │
   * │ on every /exams/live and every dashboard.                                 │
   * │                                                                           │
   * │ Awaiting the release first would only matter if this read had to SEE its  │
   * │ effect, and it does not: release_due_results changes `attempts`, while    │
   * │ this query reads `exams` and buckets them by their window. Nothing in the │
   * │ result below depends on whether a result was released a moment ago.       │
   * │                                                                           │
   * │ loadParticipation IS different — it counts released results — so it keeps │
   * │ the sequential order. The difference is deliberate, not an oversight.     │
   * └───────────────────────────────────────────────────────────────────────────┘
   */
  const [, examsResult] = await Promise.all([
    supabase.rpc('release_due_results'),
    supabase
      .from('exams')
      .select(
        'id, title, status, opens_at, closes_at, duration_minutes, question_count, total_marks, pass_mark_percent, results_release, paper_id',
      )
      .not('paper_id', 'is', null)
      .is('deleted_at', null)
      .order('closes_at', { ascending: true, nullsFirst: false }),
  ])

  const { data, error } = examsResult

  if (error) throw new Error(`The exams could not be read: ${error.message}`)

  const papers = await resolvePaperNumbers(
    supabase,
    (data ?? []).map((e) => e.paper_id).filter((id): id is string => id !== null),
  )

  const buckets: Record<ExamState, LiveExamRow[]> = {
    draft: [], scheduled: [], live: [], closed: [], cancelled: [],
  }

  for (const row of (data ?? []) as ExamRecord[]) {
    const state = examState(
      { status: row.status, opensAt: row.opens_at, closesAt: row.closes_at },
    )

    buckets[state].push({
      id: row.id,
      title: row.title,
      paperId: row.paper_id,
      paperNo: row.paper_id ? (papers.get(row.paper_id) ?? null) : null,
      state,
      opensAt: row.opens_at,
      closesAt: row.closes_at,
      durationMinutes: row.duration_minutes,
      questionCount: row.question_count,
      totalMarks: row.total_marks === null ? null : Number(row.total_marks),
      passMarkPercent: row.pass_mark_percent,
      resultsRelease: row.results_release,
      eligible: 0, notStarted: 0, inProgress: 0, submitted: 0, released: 0,
      attemptPercent: 0, submittedPercent: 0,
    })
  }

  return buckets
}

/** paper_id → paper_no, for the "Paper 9" identifier the screens show. */
async function resolvePaperNumbers(
  supabase: Awaited<ReturnType<typeof createClient>>,
  ids: string[],
): Promise<Map<string, number>> {
  if (ids.length === 0) return new Map()

  const { data } = await supabase
    .from('exam_papers')
    .select('id, paper_no')
    .in('id', [...new Set(ids)])

  return new Map((data ?? []).map((p) => [p.id, p.paper_no]))
}

/**
 * Fill in the participation counts for a set of exams.
 *
 * Separate from loadExamsByState because the closed-exam history does not need
 * them per row and the dashboard needs only totals — and each call is an RPC
 * that expands the audience.
 */
export async function withParticipation(rows: LiveExamRow[]): Promise<LiveExamRow[]> {
  const supabase = await createClient()

  return Promise.all(
    rows.map(async (row) => {
      const { data } = await supabase.rpc('exam_participation', { p_exam_id: row.id })
      const p = (data as unknown as ParticipationRow[] | null)?.[0]
      if (!p) return row

      return {
        ...row,
        eligible: p.eligible,
        notStarted: p.not_started,
        inProgress: p.in_progress,
        submitted: p.submitted,
        released: p.released,
        // "Attempted" is anyone who started, finished or not.
        attemptPercent: percentOf(p.in_progress + p.submitted, p.eligible),
        submittedPercent: percentOf(p.submitted, p.eligible),
      }
    }),
  )
}

interface ParticipationRow {
  eligible: number
  not_started: number
  in_progress: number
  submitted: number
  released: number
}

export interface ParticipantRow {
  employeeId: string
  fullName: string | null
  email: string
  department: string | null
  startedAt: string | null
  submittedAt: string | null
  state: 'not_started' | 'in_progress' | 'submitted' | 'released' | 'expired'
  score: number | null
  maxScore: number | null
  passed: boolean | null
  released: boolean
}

/**
 * The per-employee monitoring table.
 *
 * Returns [] rather than throwing for a caller who holds exams.read but not
 * attempts.read_team/read_all: they may see the exam and its counts, and the
 * page simply does not offer the table. 0064 refuses them at the database too,
 * so this is the readable copy of that rule and not the enforcement of it.
 */
export async function loadParticipants(examId: string): Promise<ParticipantRow[]> {
  const claims = await requirePermission('exams.read')

  if (!can(claims, 'attempts.read_all') && !can(claims, 'attempts.read_team')) {
    return []
  }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('exam_participants', { p_exam_id: examId })

  if (error) return []

  return ((data ?? []) as unknown as Array<{
    employee_id: string
    full_name: string | null
    email: string
    department: string | null
    started_at: string | null
    submitted_at: string | null
    state: ParticipantRow['state']
    score: number | null
    max_score: number | null
    passed: boolean | null
    released: boolean
  }>).map((r) => ({
    employeeId: r.employee_id,
    fullName: r.full_name,
    email: r.email,
    department: r.department,
    startedAt: r.started_at,
    submittedAt: r.submitted_at,
    state: r.state,
    score: r.score === null ? null : Number(r.score),
    maxScore: r.max_score === null ? null : Number(r.max_score),
    passed: r.passed,
    released: r.released,
  }))
}

/** Participation for one exam, for the monitoring header. */
export async function loadParticipation(examId: string) {
  await requirePermission('exams.read')

  const supabase = await createClient()
  await supabase.rpc('release_due_results')

  const { data } = await supabase.rpc('exam_participation', { p_exam_id: examId })
  const p = (data as unknown as ParticipationRow[] | null)?.[0]

  if (!p) {
    return {
      eligible: 0, notStarted: 0, inProgress: 0, submitted: 0, released: 0,
      attemptPercent: 0, submittedPercent: 0,
    }
  }

  return {
    eligible: p.eligible,
    notStarted: p.not_started,
    inProgress: p.in_progress,
    submitted: p.submitted,
    released: p.released,
    attemptPercent: percentOf(p.in_progress + p.submitted, p.eligible),
    submittedPercent: percentOf(p.submitted, p.eligible),
  }
}

/**
 * The dashboard card: four numbers, no per-exam detail.
 *
 * `attemptsToday` counts submissions since local midnight rather than in the
 * last 24 hours — "submitted today" on a dashboard means the calendar day the
 * reader is having.
 */
export async function loadLiveSummary() {
  await requirePermission('exams.read')

  const supabase = await createClient()

  // Concurrent with the read, for the reason spelled out in loadExamsByState:
  // this query reads `exams` and buckets them by their window, and nothing in
  // that depends on whether a due result was released a moment ago. One fewer
  // round trip on the most-visited page in the product.
  const [, examsResult] = await Promise.all([
    supabase.rpc('release_due_results'),
    supabase
      .from('exams')
      .select('id, status, opens_at, closes_at')
      .not('paper_id', 'is', null)
      .is('deleted_at', null),
  ])
  const { data: exams } = examsResult

  const rows = (exams ?? []) as Array<{
    id: string
    status: StoredExamStatus
    opens_at: string | null
    closes_at: string | null
  }>

  const byState = rows.map((e) => ({
    id: e.id,
    state: examState({ status: e.status, opensAt: e.opens_at, closesAt: e.closes_at }),
  }))

  const liveIds = byState.filter((e) => e.state === 'live').map((e) => e.id)

  const midnight = new Date()
  midnight.setHours(0, 0, 0, 0)

  const [{ count: running }, { count: submittedToday }] = await Promise.all([
    liveIds.length
      ? supabase
          .from('attempts')
          .select('id', { count: 'exact', head: true })
          .in('exam_id', liveIds)
          .eq('status', 'in_progress')
      : Promise.resolve({ count: 0 }),
    supabase
      .from('attempts')
      .select('id', { count: 'exact', head: true })
      .gte('submitted_at', midnight.toISOString()),
  ])

  return {
    live: liveIds.length,
    upcoming: byState.filter((e) => e.state === 'scheduled').length,
    closed: byState.filter((e) => e.state === 'closed').length,
    activeAttempts: running ?? 0,
    submittedToday: submittedToday ?? 0,
  }
}
