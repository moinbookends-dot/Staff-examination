'use server'

import { z } from 'zod'
import { drainPushSafely } from '@/app/api/cron/push/deps'
import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/auth/guards'
import { createClient } from '@/lib/supabase/server'
import { dbId } from '@/lib/db/id'
import { examFiltersSchema, EXAMS_PAGE_SIZE } from '@/lib/exams/filters'
import {
  assignmentSchema,
  type ExamKind,
  type ExamStatus,
} from '@/lib/exams/rules'
import type { HealthIssue } from '@/lib/exams/health'

/**
 * The exam layer's read and write paths.
 *
 * As with questions.ts, EVERY QUERY USES THE USER'S CLIENT so migration 0015's
 * policies do the company, brand and assignment scoping. The four RPCs
 * (exam_health, publish_exam, duplicate_exam) are SECURITY DEFINER and carry
 * their own permission checks, because they must read tables the caller
 * deliberately has no policy on.
 */

export interface MutationResult {
  ok: boolean
  error?: string
  issues?: HealthIssue[]
}

export interface ExamListItem {
  id: string
  title: string
  kind: ExamKind
  status: ExamStatus
  paper_mode: 'fixed' | 'per_attempt'
  duration_minutes: number
  question_count: number | null
  total_marks: number | null
  opens_at: string | null
  closes_at: string | null
  requires_manual_grading: boolean
  updated_at: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

export async function listExams(
  input: unknown,
): Promise<{ items: ExamListItem[]; total: number; page: number; pageSize: number }> {
  await requirePermission('exams.read')

  const parsed = examFiltersSchema.safeParse(input ?? {})
  const filters = parsed.success ? parsed.data : { page: 1 }
  const from = (filters.page - 1) * EXAMS_PAGE_SIZE

  const supabase = await createClient()
  let query = supabase
    .from('exams')
    .select(
      'id, title, kind, status, paper_mode, duration_minutes, question_count, total_marks, opens_at, closes_at, requires_manual_grading, updated_at',
      { count: 'exact' },
    )
    .is('deleted_at', null)

  if (filters.status) query = query.eq('status', filters.status)
  if (filters.kind) query = query.eq('kind', filters.kind)

  const { data, error, count } = await query
    .order('updated_at', { ascending: false })
    .range(from, from + EXAMS_PAGE_SIZE - 1)

  if (error) return { items: [], total: 0, page: filters.page, pageSize: EXAMS_PAGE_SIZE }
  return {
    items: (data ?? []) as ExamListItem[],
    total: count ?? 0,
    page: filters.page,
    pageSize: EXAMS_PAGE_SIZE,
  }
}

export async function getExam(id: string) {
  await requirePermission('exams.read')

  const supabase = await createClient()
  const [{ data: exam }, { data: sections }, { data: assignments }] = await Promise.all([
    supabase.from('exams').select('*').eq('id', id).is('deleted_at', null).maybeSingle(),
    supabase.from('exam_sections').select('*').eq('exam_id', id).order('sort_order'),
    supabase.from('exam_assignments').select('*').eq('exam_id', id),
  ])

  if (!exam) return null

  // Rules are fetched separately rather than through PostgREST's embedded
  // select. `scripts/gen-types.mjs` emits `Relationships: []`, so an embed like
  // `exam_sections(*, exam_rules(*))` works at runtime but is untypeable — and
  // a cast to paper over that would hide a genuinely wrong query just as
  // readily as a correct one.
  const sectionIds = (sections ?? []).map((s) => s.id)
  const { data: rules } = sectionIds.length
    ? await supabase
        .from('exam_rules')
        .select('*')
        .in('section_id', sectionIds)
        .order('sort_order')
    : { data: [] }

  // Provenance: who published it, not just when. `published_by` is a uuid, and
  // "published by 4f2a…" answers nobody's question.
  let publishedByName: string | null = null
  if (exam.published_by) {
    const { data: publisher } = await supabase
      .from('profiles')
      .select('full_name')
      .eq('id', exam.published_by)
      .maybeSingle()
    publishedByName = publisher?.full_name ?? null
  }

  return {
    exam,
    publishedByName,
    sections: (sections ?? []).map((section) => ({
      ...section,
      rules: (rules ?? []).filter((r) => r.section_id === section.id),
    })),
    assignments: assignments ?? [],
  }
}


export interface PaperQuestion {
  section_id: string
  section_title: string
  question_id: string
  question_revision: number
  paper_position: number
  marks: number
  negative_marks: number
  fallback_reason: string | null
  snapshot: {
    question_id: string
    revision: number
    type: string
    response_format: string
    stem: string
    content: unknown
    estimated_seconds: number | null
    media: unknown[]
  }
  /** True when this is a representative draw, not anybody's actual paper. */
  is_preview: boolean
}


export interface RuleCount {
  rule_id: string
  /** How many questions this rule matches on its own, within its difficulty band. */
  available: number
  /** How many it actually gets once earlier rules have taken theirs. */
  drawn: number
}


// ─────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────


const scheduleSchema = z.object({
  examId: dbId(),
  opensAt: z.string().datetime().nullable().default(null),
  closesAt: z.string().datetime().nullable().default(null),
  timezone: z.string().min(1).max(60).default('Asia/Kolkata'),
})

/**
 * The exam window.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ AFTER PUBLISH, ONLY closes_at MAY MOVE. This is not a UI preference —     │
 * │ it is what migration 0016's trigger permits, and sending anything else    │
 * │ would be refused with a constraint error rather than a sentence.          │
 * │                                                                           │
 * │ Extending a window because a shift ran late is routine and changes        │
 * │ nothing about what was asked. Moving the OPENING of an exam that is       │
 * │ already scheduled changes when people were told to sit it, and for an     │
 * │ exam already open it is meaningless.                                      │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * The narrowing happens here rather than being left to the trigger so the chef
 * gets "this exam is published, only its closing time can change" instead of a
 * raised exception — and so the rule is stated once, in the same words, in both
 * layers.
 */
export async function updateSchedule(input: unknown): Promise<MutationResult> {
  const claims = await requirePermission('exams.update')

  const parsed = scheduleSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid schedule.' }
  }

  const { examId, opensAt, closesAt, timezone } = parsed.data
  if (opensAt && closesAt && new Date(closesAt) <= new Date(opensAt)) {
    return { ok: false, error: 'The exam would close before it opens.' }
  }

  const supabase = await createClient()
  const { data: exam } = await supabase
    .from('exams')
    .select('status')
    .eq('id', examId)
    .is('deleted_at', null)
    .maybeSingle()

  if (!exam) return { ok: false, error: 'That exam no longer exists.' }

  const patch =
    exam.status === 'draft'
      ? { opens_at: opensAt, closes_at: closesAt, timezone, updated_by: claims.userId }
      : { closes_at: closesAt, updated_by: claims.userId }

  const { error } = await supabase.from('exams').update(patch).eq('id', examId)
  if (error) return { ok: false, error: friendlyWriteError(error) }

  revalidatePath('/exams')
  revalidatePath(`/exams/${examId}`)
  return { ok: true }
}


const setAssignmentsSchema = z.object({
  examId: dbId(),
  assignments: z.array(assignmentSchema).max(100),
})

/**
 * Replace an exam's audience.
 *
 * Assignments stay editable after publish — the 0016 lock covers content, not
 * who sits it. Adding a late-joining outlet to a running exam is routine.
 */
export async function setAssignments(input: unknown): Promise<MutationResult> {
  const claims = await requirePermission('exams.assign')

  const parsed = setAssignmentsSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid assignment.' }
  }

  const supabase = await createClient()
  const { error: wipeError } = await supabase
    .from('exam_assignments')
    .delete()
    .eq('exam_id', parsed.data.examId)
  if (wipeError) return { ok: false, error: friendlyWriteError(wipeError) }

  if (parsed.data.assignments.length > 0) {
    const { error } = await supabase.from('exam_assignments').insert(
      parsed.data.assignments.map((a) => ({
        exam_id: parsed.data.examId,
        target_kind: a.targetKind,
        target_id: a.targetId,
        target_role: a.targetRole,
        target_user_id: a.targetUserId,
        assigned_by: claims.userId,
      })),
    )
    if (error) return { ok: false, error: friendlyWriteError(error) }
  }

  /*
   * The inline push nudge. The insert above fired 0074's trigger, which wrote
   * the notification rows; draining here puts them on lock screens in seconds
   * instead of at the next cron tick. Fire-and-forget by contract — push
   * failing must never fail the assignment that caused it.
   */
  await drainPushSafely()

  revalidatePath(`/exams/${parsed.data.examId}`)
  return { ok: true }
}

/**
 * 'scheduled' IS DELIBERATELY ABSENT.
 *
 * Publishing is publishExam() and nothing else. When 'scheduled' was accepted
 * here, anyone holding exams.update — not exams.publish — could move a draft
 * straight to scheduled, skipping exam_health() entirely. For a per_attempt
 * exam the database's CHECK did not catch it either, so an exam with no rules
 * and no validation went live and was then locked permanently by the 0016
 * trigger. Migration 0021 closes the database half; this closes the app half.
 */
const statusSchema = z.object({
  id: dbId(),
  status: z.enum(['active', 'completed', 'archived', 'cancelled']),
})

export async function setExamStatus(input: unknown): Promise<MutationResult> {
  await requirePermission('exams.update')

  const parsed = statusSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Invalid status.' }

  const supabase = await createClient()

  /*
   * ── The scheduled-but-open gap ─────────────────────────────────────────────
   *
   * An exam published with no opening time is open the moment it exists —
   * examState() derives 'live' — but its STORED status stays 'scheduled',
   * because nothing ever advances it (there is no clock in the database).
   * 0016's transition matrix, reasoning from the stored value, then refuses
   * scheduled → completed, and the "Close now" button the live state offers
   * became a button that could only fail.
   *
   * The stored row is stepped through the legal path instead: scheduled →
   * active is what the passage of the opening time MEANS, so recording it on
   * the way to 'completed' is writing down a fact, not forging one. Each step
   * runs the trigger's own validation.
   */
  if (parsed.data.status === 'completed') {
    const { data: current } = await supabase
      .from('exams')
      .select('status')
      .eq('id', parsed.data.id)
      .is('deleted_at', null)
      .maybeSingle()

    if (current?.status === 'scheduled') {
      const { error: stepError } = await supabase
        .from('exams')
        .update({ status: 'active' })
        .eq('id', parsed.data.id)
        .is('deleted_at', null)
      if (stepError) return { ok: false, error: friendlyWriteError(stepError) }
    }
  }

  const { error } = await supabase
    .from('exams')
    .update({ status: parsed.data.status })
    .eq('id', parsed.data.id)
    .is('deleted_at', null)

  if (error) return { ok: false, error: friendlyWriteError(error) }

  revalidatePath('/exams')
  revalidatePath(`/exams/${parsed.data.id}`)
  return { ok: true }
}


// ─────────────────────────────────────────────────────────────────────────────

/**
 * Postgres errors a chef might actually cause, in words that suggest the fix.
 * Anything else stays generic — a raw constraint name helps nobody.
 */
function friendlyWriteError(error: { message?: string; code?: string } | null): string {
  const message = error?.message ?? ''
  if (message.includes('this exam is published')) {
    return 'This exam is published. Duplicate it to make changes.'
  }
  if (message.includes('cannot move an exam from')) {
    return message.replace(/^.*?cannot move/, 'Cannot move')
  }
  if (error?.code === '42501') return 'You do not have permission to do that.'
  if (error?.code === '23505') return 'That already exists.'
  return 'Could not save this exam.'
}
