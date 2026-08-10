'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/auth/guards'
import { createClient } from '@/lib/supabase/server'
import { dbId } from '@/lib/db/id'
import type { AnswerPayload } from '@/lib/questions/schemas'
import type { ActionResult } from './attempts'
import type { Database } from '@/lib/db/database.types'

type AttemptStatus = Database['public']['Enums']['attempt_status']

/**
 * The marking side.
 *
 * READS come through the user's client so 0026's policies scope them: a chef
 * holding attempts.read_team sees their outlet, HR holding attempts.read_all
 * sees the company. Nothing here filters by hand.
 *
 * WRITES all go through 0028's SECURITY DEFINER functions, which is where the
 * rules live that must not be re-stated in TypeScript: only the outstanding
 * questions may be marked, a score cannot exceed the marks available, an
 * evaluation cannot be completed while something is unmarked, a verifier may
 * not be the evaluator, and dual mode needs two distinct people.
 */

export interface QueueItem {
  attempt_id: string
  exam_title: string
  candidate_name: string
  status: string
  submitted_at: string | null
  score: number | null
  max_score: number | null
  /** How many times this paper has already been sent back. */
  returned_count: number
  verification_mode: string
  /** Sign-offs recorded in the current round. */
  signoffs: number
  /** True when the viewer marked it, so the UI can explain why it is closed to them. */
  evaluated_by_me: boolean
}

export interface EvaluationItem {
  question_id: string
  paper_position: number
  stem: string
  response_format: string
  marks: number
  answer: AnswerPayload | null
  score: number | null
  grader_note: string | null
  auto_grade_status: string
  /** The rubric the author wrote. Manual formats only — see 0028. */
  guidance: { rubric?: Array<{ id: string; label: string; max: number }>; keywords?: string[] } | null
  /**
   * ┌───────────────────────────────────────────────────────────────────────────┐
   * │ THE MODEL ANSWER — EVALUATOR ONLY, AND IT REACHES NO OTHER SURFACE.       │
   * │                                                                           │
   * │ Frozen onto attempt_questions.answer_key when the candidate started, so   │
   * │ editing the bank afterwards cannot change what the marker is shown for a  │
   * │ paper already sat. 0066 returns it here and NOWHERE else: attempt_paper() │
   * │ and attempt_review() — the two candidate-facing readers — select the      │
   * │ snapshot, which has never contained a key.                                │
   * │                                                                           │
   * │ Null for a legacy rule-drawn question, which has a rubric instead, and    │
   * │ null for anything auto-graded.                                            │
   * └───────────────────────────────────────────────────────────────────────────┘
   */
  model_answer: string | null
}

export interface VerificationRecord {
  verifier_name: string
  decision: string
  note: string | null
  round: number
  created_at: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Queues
// ─────────────────────────────────────────────────────────────────────────────

async function buildQueue(statuses: AttemptStatus[]): Promise<QueueItem[]> {
  const supabase = await createClient()

  const { data: attempts, error } = await supabase
    .from('attempts')
    .select('id, candidate_id, exam_id, status, submitted_at, score, max_score, returned_count, evaluated_by')
    .in('status', statuses)
    .order('submitted_at', { ascending: true })

  if (error || !attempts?.length) return []

  // Names and titles fetched separately rather than through an embedded select:
  // the join would need the foreign key's generated name, which is a brittle
  // thing to hard-code into a query.
  const [{ data: profiles }, { data: exams }, { data: signoffs }, { data: me }] = await Promise.all([
    supabase.from('profiles').select('id, full_name').in('id', attempts.map((a) => a.candidate_id)),
    supabase.from('exams').select('id, title, verification_mode').in('id', attempts.map((a) => a.exam_id)),
    supabase
      .from('attempt_verifications')
      .select('attempt_id, round, decision')
      .in('attempt_id', attempts.map((a) => a.id)),
    supabase.auth.getClaims(),
  ])

  const nameOf = new Map((profiles ?? []).map((p) => [p.id, p.full_name ?? '']))
  const examOf = new Map((exams ?? []).map((e) => [e.id, e]))
  const myId = me?.claims?.sub as string | undefined

  return attempts.map((a) => {
    const exam = examOf.get(a.exam_id)
    const round = a.returned_count + 1
    return {
      attempt_id: a.id,
      exam_title: exam?.title ?? '',
      candidate_name: nameOf.get(a.candidate_id) ?? '',
      status: a.status,
      submitted_at: a.submitted_at,
      score: a.score,
      max_score: a.max_score,
      returned_count: a.returned_count,
      verification_mode: exam?.verification_mode ?? 'dual',
      signoffs: (signoffs ?? []).filter(
        (v) => v.attempt_id === a.id && v.round === round && v.decision === 'verified',
      ).length,
      evaluated_by_me: Boolean(myId) && a.evaluated_by === myId,
    }
  })
}

/** Papers waiting for a human to mark them, including ones sent back. */
export async function listEvaluationQueue(): Promise<QueueItem[]> {
  await requirePermission('evaluation.evaluate')
  return buildQueue(['evaluating', 'returned'])
}

/** Papers marked and waiting to be signed off. */
export async function listVerificationQueue(): Promise<QueueItem[]> {
  await requirePermission('evaluation.verify')
  return buildQueue(['verifying'])
}

/**
 * Fully auto-graded papers held back because their exam asks for a sign-off.
 * Nothing to mark — somebody just has to decide the results may go out.
 */
export async function listReleaseQueue(): Promise<QueueItem[]> {
  await requirePermission('evaluation.publish')
  return buildQueue(['auto_graded'])
}

export async function getEvaluationItems(attemptId: string): Promise<EvaluationItem[]> {
  await requirePermission('evaluation.evaluate')

  const parsed = dbId().safeParse(attemptId)
  if (!parsed.success) return []

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('attempt_evaluation_items', {
    p_attempt_id: parsed.data,
  })

  if (error) return []
  return (data ?? []) as unknown as EvaluationItem[]
}

/** The audit trail, for the verifier deciding and for anyone asking later. */
export async function getVerificationHistory(attemptId: string): Promise<VerificationRecord[]> {
  await requirePermission('evaluation.verify')

  const parsed = dbId().safeParse(attemptId)
  if (!parsed.success) return []

  const supabase = await createClient()
  const { data } = await supabase
    .from('attempt_verifications')
    .select('verifier_id, decision, note, round, created_at')
    .eq('attempt_id', parsed.data)
    .order('created_at', { ascending: true })

  if (!data?.length) return []

  const { data: profiles } = await supabase
    .from('profiles')
    .select('id, full_name')
    .in('id', data.map((v) => v.verifier_id))

  const nameOf = new Map((profiles ?? []).map((p) => [p.id, p.full_name ?? '']))

  return data.map((v) => ({
    verifier_name: nameOf.get(v.verifier_id) ?? '',
    decision: v.decision,
    note: v.note,
    round: v.round,
    created_at: v.created_at,
  }))
}

// ─────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────

function message(error: { message?: string } | null): string {
  const raw = error?.message ?? ''
  const cleaned = raw.replace(/^.*?:\s*/, '').trim()
  return cleaned || 'Something went wrong. Please try again.'
}

const saveEvaluationSchema = z.object({
  attemptId: dbId(),
  questionId: dbId(),
  // The upper bound is the question's marks, which only the database knows —
  // save_evaluation() checks it against attempt_questions and refuses.
  score: z.coerce.number().min(0),
  note: z.string().max(2000).optional(),
})

export async function saveEvaluation(input: unknown): Promise<ActionResult> {
  await requirePermission('evaluation.evaluate')

  const parsed = saveEvaluationSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'That mark could not be read.' }

  const supabase = await createClient()
  const { error } = await supabase.rpc('save_evaluation', {
    p_attempt_id: parsed.data.attemptId,
    p_question_id: parsed.data.questionId,
    p_score: parsed.data.score,
    p_note: parsed.data.note ?? null,
  })

  if (error) return { ok: false, error: message(error) }
  return { ok: true }
}

export async function completeEvaluation(attemptId: string): Promise<ActionResult<{ status: string }>> {
  await requirePermission('evaluation.evaluate')

  const parsed = dbId().safeParse(attemptId)
  if (!parsed.success) return { ok: false, error: 'That attempt does not exist.' }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('complete_evaluation', { p_attempt_id: parsed.data })

  if (error) return { ok: false, error: message(error) }

  revalidatePath('/evaluate')
  revalidatePath('/verify')
  return { ok: true, data: { status: data as unknown as string } }
}

const verifySchema = z.object({
  attemptId: dbId(),
  decision: z.enum(['verified', 'returned']),
  note: z.string().max(2000).optional(),
})

export async function verifyAttempt(
  input: unknown,
): Promise<ActionResult<{ status: string }>> {
  const parsed = verifySchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'That decision could not be read.' }

  // Returning and approving are separate permissions, and the database checks
  // them again — this is the earlier of the two gates, not the only one.
  await requirePermission(parsed.data.decision === 'returned' ? 'evaluation.return' : 'evaluation.verify')

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('verify_attempt', {
    p_attempt_id: parsed.data.attemptId,
    p_decision: parsed.data.decision,
    p_note: parsed.data.note ?? null,
  })

  if (error) return { ok: false, error: message(error) }

  revalidatePath('/verify')
  revalidatePath('/evaluate')
  return { ok: true, data: { status: data as unknown as string } }
}

export async function publishAttempt(attemptId: string): Promise<ActionResult<{ status: string }>> {
  await requirePermission('evaluation.publish')

  const parsed = dbId().safeParse(attemptId)
  if (!parsed.success) return { ok: false, error: 'That attempt does not exist.' }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('publish_attempt', { p_attempt_id: parsed.data })

  if (error) return { ok: false, error: message(error) }

  revalidatePath('/verify')
  return { ok: true, data: { status: data as unknown as string } }
}
