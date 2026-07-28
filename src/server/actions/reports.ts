'use server'

import { requirePermission } from '@/lib/auth/guards'
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
