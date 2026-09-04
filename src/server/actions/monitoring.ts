'use server'

import { requirePermission, requireAnyPermission } from '@/lib/auth/guards'
import { createClient } from '@/lib/supabase/server'
import { dbId } from '@/lib/db/id'
import type { HistoryRow } from '@/lib/analytics/performance'

/**
 * Monitoring and candidate-performance reads.
 *
 * Thin wrappers, deliberately: every function here fronts a 0092 SECURITY
 * DEFINER RPC that enforces its own reach (0064's exam gate, 0030's
 * analytics_scope). The requirePermission calls are the fast, legible fail —
 * the database is the enforcement, exactly as reports.ts documents for its own
 * wrappers. Nothing here filters rows itself, because a second definition of
 * "how far may this person look" is a second thing to get wrong.
 */

const MONITOR = ['attempts.read_team', 'attempts.read_all'] as const

export interface MonitorAttemptHeader {
  attempt_id: string
  candidate_id: string
  candidate_name: string | null
  candidate_email: string
  department: string | null
  outlet: string | null
  exam_id: string
  exam_title: string
  attempt_no: number | null
  status: string
  submit_reason: string | null
  started_at: string | null
  submitted_at: string | null
  expires_at: string | null
  score: number | null
  max_score: number | null
  passed: boolean | null
  pass_mark_percent: number
  question_n: number
  answered_n: number
}

export interface MonitorReviewItem {
  question_id: string
  paper_position: number
  stem: string
  marks: number
  score: number | null
  answered: boolean
  correct: boolean | null
  needs_review: boolean
  answer: Record<string, unknown> | null
  /** Present only when the caller holds evaluation.evaluate — see 0092. */
  model_answer: string | null
}

export async function getMonitorAttemptHeader(
  attemptId: string,
): Promise<MonitorAttemptHeader | null> {
  await requireAnyPermission(MONITOR)

  const parsed = dbId().safeParse(attemptId)
  if (!parsed.success) return null

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('monitor_attempt_header', {
    p_attempt_id: parsed.data,
  })

  if (error) return null
  return ((data as unknown as MonitorAttemptHeader[] | null)?.[0]) ?? null
}

export async function getMonitorAttemptReview(attemptId: string): Promise<MonitorReviewItem[]> {
  await requireAnyPermission(MONITOR)

  const parsed = dbId().safeParse(attemptId)
  if (!parsed.success) return []

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('monitor_attempt_review', {
    p_attempt_id: parsed.data,
  })

  if (error) return []
  return (data ?? []) as unknown as MonitorReviewItem[]
}

/**
 * One candidate's attempt history. Own record needs only reports.read_own;
 * someone else's is decided by candidate_attempt_history() against
 * analytics_scope — the same split getCandidateStats has always had.
 */
export async function getCandidateHistory(candidateId?: string): Promise<HistoryRow[]> {
  await requirePermission('reports.read_own')

  const target = candidateId ? dbId().safeParse(candidateId) : null
  if (candidateId && !target?.success) return []

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('candidate_attempt_history', {
    p_candidate_id: target?.success ? target.data : undefined,
  })

  if (error) return []
  return ((data ?? []) as unknown as HistoryRow[]).map((r) => ({
    ...r,
    percent: r.percent === null ? null : Number(r.percent),
    score: r.score === null ? null : Number(r.score),
    max_score: r.max_score === null ? null : Number(r.max_score),
  }))
}
