'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/auth/guards'
import { createClient } from '@/lib/supabase/server'
import { dbId } from '@/lib/db/id'
import { answerPayloadSchema } from '@/lib/questions/schemas'
import type { AnswerPayload } from '@/lib/questions/schemas'

/**
 * The candidate's side of an exam.
 *
 * EVERY WRITE GOES THROUGH AN RPC, and that is not a style choice. 0026 gave
 * `attempts`, `attempt_questions` and `attempt_answers` no insert or update
 * policy for anybody, so there is no table-level path from here — a candidate
 * who could write directly would choose their own deadline, attempt number and
 * paper. `start_attempt`, `save_answer` and `submit_attempt` are SECURITY
 * DEFINER, carry their own ownership checks, and are the only writers.
 *
 * Reads are the user's client so RLS scopes them, except the paper: candidates
 * hold no policy on `attempt_questions`, and `attempt_paper()` is the entire
 * surface by which they ever see a question.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface CandidateExam {
  id: string
  title: string
  description: string | null
  kind: string
  duration_minutes: number
  question_count: number | null
  total_marks: number | null
  pass_mark_percent: number
  closes_at: string | null
  max_attempts: number
  /** Attempts that count against max_attempts — voided ones do not. */
  attempts_used: number
  /** Set when one is in flight, so the card offers Resume rather than Start. */
  open_attempt_id: string | null
  /** The most recent finished attempt, for the "last result" line. */
  last_status: string | null
  /** Null until the attempt is published — the database withholds it, not the UI. */
  last_score: number | null
  last_passed: boolean | null
  last_published: boolean
}

export interface AttemptQuestion {
  section_id: string | null
  section_title: string | null
  question_id: string
  paper_position: number
  marks: number
  /** Candidate-visible payload. Has never contained an answer key. */
  snapshot: Record<string, unknown>
  /** Their answer so far, so a resumed attempt comes back where it was. */
  answer: AnswerPayload | null
}

export interface AttemptState {
  attempt_id: string
  status: string
  /** THE SERVER'S deadline. The browser counts down toward it for display only. */
  expires_at: string
  submitted_at: string | null
  /** How many questions they have answered so far. */
  answered_count: number
  exam_title: string
  /** When false the runner will not offer Previous. */
  allow_backtrack: boolean
}

export interface AttemptResult {
  status: string
  score: number | null
  max_score: number | null
  passed: boolean | null
  /** False until the result is released. Everything above is null while it is. */
  published: boolean
}

export interface AttemptReviewItem {
  question_id: string
  paper_position: number
  stem: string
  marks: number
  score: number | null
  answer: AnswerPayload | null
  /** What they submitted and whether it was right — never the expected value. */
  grade_detail: Record<string, unknown> | null
  grader_note: string | null
}

export type ActionResult<T = undefined> =
  | ({ ok: true } & (T extends undefined ? object : { data: T }))
  | { ok: false; error: string }

/**
 * Turns a Postgres exception into something a candidate can act on.
 *
 * The RPCs raise deliberately vague messages for the ownership cases — "attempt
 * not found" covers both "no such attempt" and "not yours", and the two must
 * stay indistinguishable. Everything else is already candidate-facing prose
 * written at the point the rule lives, so it is passed through rather than
 * re-worded here, where it would drift from the rule it describes.
 */
function toMessage(error: { message?: string } | null): string {
  const raw = error?.message ?? ''
  if (!raw) return 'Something went wrong. Please try again.'
  // Postgres prefixes some errors; keep only the sentence the function raised.
  const cleaned = raw.replace(/^.*?:\s*/, '').trim()
  return cleaned || 'Something went wrong. Please try again.'
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The exams this candidate may sit, with what they have already done.
 *
 * Visibility is RLS's job, not this function's: 0015's policy on `exams` matches
 * the assignment against outlet, department, brand and role claims, all of which
 * are already in the JWT. Nothing is filtered by hand here, so a candidate
 * cannot be shown an exam the database would refuse them.
 */
export async function listMyExams(): Promise<CandidateExam[]> {
  await requirePermission('attempts.take')

  const supabase = await createClient()

  const { data: exams, error } = await supabase
    .from('exams')
    // One string literal, not a concatenation: supabase-js infers the row type
    // from the literal, and a `+` join degrades every column to an error type.
    .select('id, title, description, kind, duration_minutes, question_count, total_marks, pass_mark_percent, opens_at, closes_at, max_attempts, status')
    .in('status', ['scheduled', 'active'])
    .is('deleted_at', null)
    .order('closes_at', { ascending: true, nullsFirst: false })

  if (error || !exams?.length) return []

  // Through my_attempts(), not the table. 0028 dropped the candidate's read
  // policy on `attempts` precisely because a policy cannot withhold a column,
  // and score must stay invisible until the attempt is published. This function
  // returns status always and the score only once it is theirs to see.
  const { data: attempts } = await supabase.rpc('my_attempts')

  const rows = (attempts ?? []) as unknown as Array<{
    attempt_id: string
    exam_id: string
    status: string
    score: number | null
    passed: boolean | null
    started_at: string
    published: boolean
  }>

  const byExam = new Map<string, typeof rows>()
  for (const a of [...rows].sort((x, y) => y.started_at.localeCompare(x.started_at))) {
    const list = byExam.get(a.exam_id) ?? []
    list.push(a)
    byExam.set(a.exam_id, list)
  }

  const now = Date.now()

  return exams
    .filter((e) => {
      // An exam whose window has shut is not sittable; start_attempt would
      // refuse it anyway, and offering a button that always errors is worse
      // than not offering it.
      if (e.opens_at && new Date(e.opens_at).getTime() > now) return false
      if (e.closes_at && new Date(e.closes_at).getTime() <= now) return false
      return true
    })
    .map((e) => {
      const mine = byExam.get(e.id) ?? []
      const open = mine.find((a) => a.status === 'in_progress')
      const finished = mine.filter((a) => a.status !== 'in_progress' && a.status !== 'voided')
      const latest = finished[0]

      return {
        id: e.id,
        title: e.title,
        description: e.description,
        kind: e.kind,
        duration_minutes: e.duration_minutes,
        question_count: e.question_count,
        total_marks: e.total_marks,
        pass_mark_percent: e.pass_mark_percent,
        closes_at: e.closes_at,
        max_attempts: e.max_attempts,
        // Mirrors start_attempt's own count, which excludes voided attempts.
        attempts_used: mine.filter((a) => a.status !== 'voided').length,
        open_attempt_id: open?.attempt_id ?? null,
        last_status: latest?.status ?? null,
        // Null unless published — my_attempts() has already withheld it, and
        // this is not a second place to decide that.
        last_score: latest?.score ?? null,
        last_passed: latest?.passed ?? null,
        last_published: latest?.published ?? false,
      } satisfies CandidateExam
    })
}

/**
 * The paper, through the only route a candidate has to it.
 *
 * Returns [] rather than throwing when the attempt is not theirs: the RPC
 * raises 'attempt not found' for both "no such attempt" and "not yours", and
 * turning that into a distinguishable error here would undo the point.
 */
export async function getAttemptPaper(attemptId: string): Promise<AttemptQuestion[]> {
  await requirePermission('attempts.take')

  const parsed = dbId().safeParse(attemptId)
  if (!parsed.success) return []

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('attempt_paper', { p_attempt_id: parsed.data })

  if (error) return []
  return (data ?? []) as unknown as AttemptQuestion[]
}

/**
 * The attempt's own row — status and, above all, the deadline.
 *
 * The runner re-reads this periodically so a client whose clock drifts, sleeps
 * or is deliberately altered still converges on the server's answer.
 */
export async function getAttemptState(attemptId: string): Promise<AttemptState | null> {
  await requirePermission('attempts.take')

  const parsed = dbId().safeParse(attemptId)
  if (!parsed.success) return null

  const supabase = await createClient()
  // my_attempt_state() carries no score at all. A paper being sat has no result
  // worth withholding, and a function that cannot read one cannot leak one.
  const { data, error } = await supabase.rpc('my_attempt_state', { p_attempt_id: parsed.data })

  const row = (data as unknown as AttemptState[] | null)?.[0]
  if (error || !row) return null
  return row
}

/**
 * The outcome, for the page shown after submitting.
 *
 * `published` is the whole point: score, max_score and passed come back null
 * for anything the database has not released, so a page that forgot to check
 * still has nothing to show.
 */
export async function getAttemptResult(attemptId: string): Promise<AttemptResult | null> {
  await requirePermission('attempts.read_own')

  const parsed = dbId().safeParse(attemptId)
  if (!parsed.success) return null

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('my_attempts')
  if (error) return null

  const rows = (data ?? []) as unknown as Array<AttemptResult & { attempt_id: string }>
  return rows.find((r) => r.attempt_id === parsed.data) ?? null
}

/** The per-question breakdown. Raises in the database unless published. */
export async function getAttemptReview(attemptId: string): Promise<AttemptReviewItem[]> {
  await requirePermission('attempts.read_own')

  const parsed = dbId().safeParse(attemptId)
  if (!parsed.success) return []

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('attempt_review', { p_attempt_id: parsed.data })

  if (error) return []
  return (data ?? []) as unknown as AttemptReviewItem[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Writes — all four go through a SECURITY DEFINER function
// ─────────────────────────────────────────────────────────────────────────────

export async function startAttempt(examId: string): Promise<ActionResult<{ attemptId: string }>> {
  await requirePermission('attempts.take')

  const parsed = dbId().safeParse(examId)
  if (!parsed.success) return { ok: false, error: 'That exam does not exist.' }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('start_attempt', { p_exam_id: parsed.data })

  if (error) return { ok: false, error: toMessage(error) }

  const row = (data as unknown as { attempt_id: string }[] | null)?.[0]
  if (!row) return { ok: false, error: 'The attempt could not be started.' }

  revalidatePath('/my-exams')
  return { ok: true, data: { attemptId: row.attempt_id } }
}

const saveAnswerSchema = z.object({
  attemptId: dbId(),
  questionId: dbId(),
  /**
   * Validated here as well as by the database.
   *
   * save_answer() checks the format against the question's snapshot, so a
   * mismatched payload is refused either way — but parsing first means a
   * malformed answer produces a readable message instead of a Postgres
   * exception, and keeps unparseable JSON out of a column typed jsonb.
   */
  answer: answerPayloadSchema,
})

/**
 * Autosaves one answer and returns the server's deadline.
 *
 * The deadline comes back on EVERY save, not just the first, so the countdown
 * in the browser is corrected continuously against the only clock that counts.
 */
export async function saveAnswer(input: unknown): Promise<ActionResult<{ expiresAt: string }>> {
  await requirePermission('attempts.take')

  const parsed = saveAnswerSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'That answer could not be read.' }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('save_answer', {
    p_attempt_id: parsed.data.attemptId,
    p_question_id: parsed.data.questionId,
    p_answer: parsed.data.answer,
  })

  if (error) return { ok: false, error: toMessage(error) }
  return { ok: true, data: { expiresAt: data as unknown as string } }
}

const submitSchema = z.object({
  attemptId: dbId(),
  /**
   * The three a candidate can honestly claim. submit_attempt() refuses
   * 'sweeper' and 'admin' outright — they are the server's to assert — and this
   * enum keeps the UI from ever forming that request in the first place.
   */
  reason: z.enum(['user', 'timer', 'tab_switch']).default('user'),
})

export async function submitAttempt(input: unknown): Promise<ActionResult<AttemptResult>> {
  await requirePermission('attempts.take')

  const parsed = submitSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'That submission could not be read.' }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('submit_attempt', {
    p_attempt_id: parsed.data.attemptId,
    p_reason: parsed.data.reason,
  })

  if (error) return { ok: false, error: toMessage(error) }

  const row = (data as unknown as AttemptResult[] | null)?.[0]
  if (!row) return { ok: false, error: 'The attempt could not be submitted.' }

  revalidatePath('/my-exams')
  return { ok: true, data: row }
}
