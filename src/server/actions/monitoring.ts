'use server'

import { z } from 'zod'

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
  /** choice_single, text_short, … — the snapshot's own format. */
  qformat: string
  /** The content the candidate received: choices for MCQ, limits for text. */
  content: { choices?: Array<{ id: string; text: string }> } | null
  marks: number
  score: number | null
  answered: boolean
  /** The RECORDED verdict from grade_detail — never recomputed. */
  correct: boolean | null
  needs_review: boolean
  /** The option id the candidate picked, for MCQ. */
  selected: string | null
  /** The text the candidate wrote, for short answers. */
  answer_text: string | null
  /** Present only when the caller holds evaluation.evaluate — see 0093. */
  correct_answer: string | null
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

// ─────────────────────────────────────────────────────────────────────────────
// The Users page — list, roles, access. All three front 0093 RPCs that gate
// themselves; the checks here are the fast legible fail, as everywhere above.
// ─────────────────────────────────────────────────────────────────────────────

const USERS = ['users.read_team', 'users.read_all'] as const

export interface AdminUserRow {
  user_id: string
  full_name: string | null
  email: string
  employee_code: string | null
  department: string | null
  outlet: string | null
  approval_status: string
  role_keys: string[]
  last_attempt_at: string | null
}

export async function listUsers(): Promise<AdminUserRow[]> {
  await requireAnyPermission(USERS)
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('admin_list_users')
  if (error) return []
  return (data ?? []) as unknown as AdminUserRow[]
}

export async function listRoles(): Promise<Array<{ role_key: string; role_name: string }>> {
  await requireAnyPermission(USERS)
  const supabase = await createClient()
  const { data, error } = await supabase.rpc('list_roles')
  if (error) return []
  return (data ?? []) as unknown as Array<{ role_key: string; role_name: string }>
}

/**
 * Role + department + outlet in one confirmed save. set_user_access() (0093)
 * enforces the rules that matter — super-admin-only via users.assign_roles,
 * never your own row, never the last super admin — so a forged client request
 * hits the same wall this form does.
 */
export async function setUserAccess(input: unknown): Promise<{ ok: boolean; error?: string }> {
  await requirePermission('users.assign_roles')

  const schema = z.object({
    userId: dbId(),
    roleKey: z.string().min(1).max(64),
    departmentId: dbId().nullable().optional(),
    outletId: dbId().nullable().optional(),
  })
  const parsed = schema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Check the form and try again.' }

  const supabase = await createClient()
  const { error } = await supabase.rpc('set_user_access', {
    p_user_id: parsed.data.userId,
    p_role_key: parsed.data.roleKey,
    p_department_id: parsed.data.departmentId ?? undefined,
    p_outlet_id: parsed.data.outletId ?? undefined,
  })

  if (error) {
    const raw = error.message ?? ''
    if (/own access/i.test(raw)) return { ok: false, error: 'You cannot change your own access.' }
    if (/last super admin/i.test(raw)) return { ok: false, error: 'Someone must remain super admin — demote yourself last, via another super admin.' }
    if (/forbidden/i.test(raw)) return { ok: false, error: 'Only a super admin can manage access.' }
    return { ok: false, error: 'Could not save the changes.' }
  }
  return { ok: true }
}
