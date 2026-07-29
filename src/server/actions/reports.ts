'use server'

import { requirePermission, requireAnyPermission } from '@/lib/auth/guards'
import { createClient } from '@/lib/supabase/server'
import { dbId } from '@/lib/db/id'

/**
 * Reporting reads.
 *
 * Every one of these is a SECURITY DEFINER function that decides its own reach
 * from the caller's permissions — see analytics_scope() in 0030. Nothing here
 * filters by outlet or company, because a second definition of "how far may
 * this person look" is a second thing to get wrong, and this one is not
 * protected by RLS: the functions read a view that deliberately bypasses it.
 */

export interface CandidateStats {
  candidate_id: string
  attempts_n: number
  passed_n: number
  /** Null when there are no attempts — NOT zero, which would read as total failure. */
  pass_rate: number | null
  avg_percent: number | null
  best_percent: number | null
  last_attempt_at: string | null
}

export interface CategoryStat {
  category_id: string
  category_name: string
  questions_n: number
  /** Mean proportion of available marks earned, 0–1. */
  facility: number | null
}

export interface TeamMemberStats {
  candidate_id: string
  full_name: string
  outlet_id: string | null
  attempts_n: number
  passed_n: number
  pass_rate: number | null
  avg_percent: number | null
  last_attempt_at: string | null
}

export interface ExamStats {
  exam_id: string
  title: string
  attempts_n: number
  candidates_n: number
  pass_rate: number | null
  avg_percent: number | null
  median_percent: number | null
  avg_minutes: number | null
}

export interface QuestionStats {
  question_id: string
  question_revision: number
  stem: string
  category_id: string | null
  category_name: string | null
  /** What the author rated it, 1–5. */
  author_difficulty: number
  attempts_n: number
  facility: number | null
  full_marks_rate: number | null
  /** NULL below the sample floor — see 0030. Absence is the honest answer. */
  discrimination: number | null
  observed_difficulty: number
  misrated: boolean
}

/**
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHY THESE THREE TAKE requireAnyPermission AND NOT requirePermission.      │
 * │                                                                           │
 * │ They were guarded on `reports.read_team` alone. HR holds `reports.        │
 * │ read_all` — which is strictly WIDER — and not `read_team`, so every one   │
 * │ of these threw for HR. /reports gates its team sections on                │
 * │ `read_team || read_all` and then calls all three, and with no error        │
 * │ boundary in the app that throw surfaced as a 500. Verified against this   │
 * │ database: /en/reports and /api/reports/export both returned 500 for an    │
 * │ HR user, and 200 for a chef, which is exactly why nobody noticed.         │
 * │                                                                           │
 * │ This is not a widening of access. analytics_scope() in 0030 already maps  │
 * │ read_all → 'all', a superset of 'team', so the SQL was written for this   │
 * │ caller from the start — and requireAnyPermission's own docstring names    │
 * │ this exact case ("a report a chef sees via reports.read_team and HR sees  │
 * │ via reports.read_all"). The helper existed and was never wired up.        │
 * │                                                                           │
 * │ THE GENERAL RULE, which /dashboard is now built on: where a screen is     │
 * │ reachable by two different grants, the ACTION widens, never the caller.   │
 * │ A page that ORs two keys in front of an action guarded on one of them is  │
 * │ a 500 waiting for whichever role holds the other.                         │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
const TEAM_OR_ALL = ['reports.read_team', 'reports.read_all'] as const

/**
 * Everyone in reach, including those who have sat nothing.
 *
 * The zero rows are the point: "who still needs to do this" is what a chef
 * opens the report to find out, so team_stats() LEFT JOINs rather than
 * dropping them.
 */
export async function getTeamStats(): Promise<TeamMemberStats[]> {
  await requireAnyPermission(TEAM_OR_ALL)

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('team_stats')

  if (error) return []
  return (data ?? []) as unknown as TeamMemberStats[]
}

export async function getExamStats(examId?: string): Promise<ExamStats[]> {
  await requireAnyPermission(TEAM_OR_ALL)

  const target = examId ? dbId().safeParse(examId) : null
  if (examId && !target?.success) return []

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('exam_stats', {
    p_exam_id: target?.success ? target.data : undefined,
  })

  if (error) return []
  return (data ?? []) as unknown as ExamStats[]
}

/**
 * Item analysis, most-answered first.
 *
 * Returns one row per (question, revision): rewording a question starts its
 * statistics again, which is what 0011's revision counter is for.
 */
export async function getQuestionStats(categoryId?: string): Promise<QuestionStats[]> {
  await requireAnyPermission(TEAM_OR_ALL)

  const target = categoryId ? dbId().safeParse(categoryId) : null
  if (categoryId && !target?.success) return []

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('question_stats', {
    p_question_id: undefined,
    p_category_id: target?.success ? target.data : undefined,
  })

  if (error) return []
  return (data ?? []) as unknown as QuestionStats[]
}

/** One candidate's record. Defaults to the signed-in user. */
export async function getCandidateStats(candidateId?: string): Promise<CandidateStats | null> {
  await requirePermission('reports.read_own')

  const target = candidateId ? dbId().safeParse(candidateId) : null
  if (candidateId && !target?.success) return null

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('candidate_stats', {
    p_candidate_id: target?.success ? target.data : undefined,
  })

  if (error) return null
  return ((data as unknown as CandidateStats[] | null)?.[0]) ?? null
}

/**
 * Where they are strong and weak, weakest first.
 *
 * Ordered by the database so the answer to "what should I revise" is the top of
 * the list rather than something the reader has to work out.
 */
export async function getCandidateCategoryStats(candidateId?: string): Promise<CategoryStat[]> {
  await requirePermission('reports.read_own')

  const target = candidateId ? dbId().safeParse(candidateId) : null
  if (candidateId && !target?.success) return []

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('candidate_category_stats', {
    p_candidate_id: target?.success ? target.data : undefined,
  })

  if (error) return []
  return (data ?? []) as unknown as CategoryStat[]
}
