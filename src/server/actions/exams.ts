'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/auth/guards'
import { createClient } from '@/lib/supabase/server'
import { dbId } from '@/lib/db/id'
import {
  examSchema,
  examSectionSchema,
  assignmentSchema,
  DEFAULT_PAPER_MODE,
  DEFAULT_COUNTS_TOWARDS_ANALYTICS,
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

const PAGE_SIZE = 25

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

const listFiltersSchema = z.object({
  status: z.enum(['draft', 'scheduled', 'active', 'completed', 'archived', 'cancelled']).optional(),
  kind: z
    .enum(['official', 'practice', 'quiz', 'monthly', 'annual', 'practical'])
    .optional(),
  page: z.coerce.number().int().min(1).default(1),
})

export async function listExams(
  input: unknown,
): Promise<{ items: ExamListItem[]; total: number; page: number; pageSize: number }> {
  await requirePermission('exams.read')

  const parsed = listFiltersSchema.safeParse(input ?? {})
  const filters = parsed.success ? parsed.data : { page: 1 }
  const from = (filters.page - 1) * PAGE_SIZE

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
    .range(from, from + PAGE_SIZE - 1)

  if (error) return { items: [], total: 0, page: filters.page, pageSize: PAGE_SIZE }
  return {
    items: (data ?? []) as ExamListItem[],
    total: count ?? 0,
    page: filters.page,
    pageSize: PAGE_SIZE,
  }
}

export async function getExam(id: string) {
  await requirePermission('exams.read')

  const supabase = await createClient()
  const [{ data: exam }, { data: sections }, { data: assignments }] = await Promise.all([
    supabase.from('exams').select('*').eq('id', id).is('deleted_at', null).maybeSingle(),
    supabase
      .from('exam_sections')
      .select('*, exam_rules(*)')
      .eq('exam_id', id)
      .order('sort_order'),
    supabase.from('exam_assignments').select('*').eq('exam_id', id),
  ])

  if (!exam) return null
  return { exam, sections: sections ?? [], assignments: assignments ?? [] }
}

/**
 * The health report.
 *
 * Straight through to the RPC — deliberately no filtering, reshaping or
 * re-deriving of severity here. The database decides what blocks; this only
 * carries the answer.
 */
export async function getExamHealth(id: string): Promise<HealthIssue[]> {
  await requirePermission('exams.update')

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('exam_health', { p_exam_id: id })
  if (error) return []
  return (data ?? []) as unknown as HealthIssue[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────

const saveExamSchema = examSchema.extend({
  sections: z.array(examSectionSchema).default([]),
})

export async function saveExam(
  input: unknown,
): Promise<MutationResult & { id?: string }> {
  const parsed = saveExamSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid exam.' }
  }

  const v = parsed.data
  const claims = await requirePermission(v.id ? 'exams.update' : 'exams.create')
  if (!claims.company_id) return { ok: false, error: 'No company on your account.' }

  const supabase = await createClient()

  // paper_mode and counts_towards_analytics default FROM the kind but are
  // stored as columns, so an explicit choice survives. Only derive when the
  // caller did not decide.
  const row = {
    company_id: claims.company_id,
    brand_id: v.brandId,
    title: v.title,
    description: v.description,
    instructions: v.instructions,
    kind: v.kind,
    paper_mode: v.paperMode ?? DEFAULT_PAPER_MODE[v.kind],
    counts_towards_analytics: DEFAULT_COUNTS_TOWARDS_ANALYTICS[v.kind],
    duration_minutes: v.durationMinutes,
    opens_at: v.opensAt,
    closes_at: v.closesAt,
    timezone: v.timezone,
    max_attempts: v.maxAttempts,
    pass_mark_percent: v.passMarkPercent,
    shuffle_questions: v.shuffleQuestions,
    shuffle_options: v.shuffleOptions,
    allow_backtrack: v.allowBacktrack,
    negative_marking_enabled: v.negativeMarkingEnabled,
    verification_mode: v.verificationMode,
    updated_by: claims.userId,
  }

  let examId = v.id
  if (examId) {
    const { error } = await supabase.from('exams').update(row).eq('id', examId).is('deleted_at', null)
    if (error) return { ok: false, error: friendlyWriteError(error) }
  } else {
    const { data, error } = await supabase
      .from('exams')
      .insert({ ...row, created_by: claims.userId! })
      .select('id')
      .single()
    if (error || !data) return { ok: false, error: friendlyWriteError(error) }
    examId = data.id
  }

  // Sections and rules are a replace-set: the builder sends the whole tree, so
  // a merge would make deleting a rule impossible. Cascade removes the rules
  // with their section.
  const { error: wipeError } = await supabase.from('exam_sections').delete().eq('exam_id', examId)
  if (wipeError) return { ok: false, error: friendlyWriteError(wipeError) }

  for (const [index, section] of v.sections.entries()) {
    const { data: created, error: sectionError } = await supabase
      .from('exam_sections')
      .insert({
        exam_id: examId,
        title: section.title,
        description: section.description,
        instructions: section.instructions,
        duration_minutes: section.durationMinutes,
        sort_order: index,
      })
      .select('id')
      .single()

    if (sectionError || !created) return { ok: false, error: friendlyWriteError(sectionError) }

    if (section.rules.length > 0) {
      const { error: ruleError } = await supabase.from('exam_rules').insert(
        section.rules.map((rule, ruleIndex) => ({
          section_id: created.id,
          sort_order: ruleIndex,
          category_id: rule.categoryId,
          include_subcategories: rule.includeSubcategories,
          tag_ids: rule.tagIds,
          question_types: rule.questionTypes,
          difficulty_min: rule.difficultyMin,
          difficulty_max: rule.difficultyMax,
          question_count: rule.questionCount,
          marks_per_question: rule.marksPerQuestion,
        })),
      )
      if (ruleError) return { ok: false, error: friendlyWriteError(ruleError) }
    }
  }

  revalidatePath('/exams')
  revalidatePath(`/exams/${examId}`)
  return { ok: true, id: examId }
}

/**
 * Publish.
 *
 * The RPC runs exam_health() and refuses on any blocking row, returning them in
 * the error. Parsing them back out here means the editor can list exactly which
 * rule fell short rather than showing "publish failed".
 */
export async function publishExam(id: string): Promise<MutationResult> {
  await requirePermission('exams.publish')

  const supabase = await createClient()
  const { error } = await supabase.rpc('publish_exam', { p_exam_id: id })

  if (error) {
    const issues = parseBlockingIssues(error.message)
    if (issues) {
      return { ok: false, error: 'This exam is not ready to publish.', issues }
    }
    return { ok: false, error: friendlyWriteError(error) }
  }

  revalidatePath('/exams')
  revalidatePath(`/exams/${id}`)
  return { ok: true }
}

const duplicateSchema = z.object({
  id: dbId(),
  title: z.string().trim().min(3).max(200).optional(),
})

export async function duplicateExam(
  input: unknown,
): Promise<MutationResult & { id?: string }> {
  await requirePermission('exams.create')

  const parsed = duplicateSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Invalid exam.' }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('duplicate_exam', {
    p_exam_id: parsed.data.id,
    p_title: parsed.data.title ?? null,
  })

  if (error) return { ok: false, error: friendlyWriteError(error) }

  revalidatePath('/exams')
  return { ok: true, id: data as unknown as string }
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
        assigned_by: claims.userId,
      })),
    )
    if (error) return { ok: false, error: friendlyWriteError(error) }
  }

  revalidatePath(`/exams/${parsed.data.examId}`)
  return { ok: true }
}

const statusSchema = z.object({
  id: dbId(),
  status: z.enum(['scheduled', 'active', 'completed', 'archived', 'cancelled']),
})

export async function setExamStatus(input: unknown): Promise<MutationResult> {
  await requirePermission('exams.update')

  const parsed = statusSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Invalid status.' }

  const supabase = await createClient()
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

export async function deleteExam(id: string): Promise<MutationResult> {
  await requirePermission('exams.archive')

  const supabase = await createClient()
  const { error } = await supabase
    .from('exams')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .is('deleted_at', null)

  if (error) return { ok: false, error: friendlyWriteError(error) }

  revalidatePath('/exams')
  return { ok: true }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * publish_exam() raises with the blocking rows serialised as JSON. Recovering
 * them turns "publish failed" into "rule 2 asked for 15 and the bank holds 6",
 * which is the difference between a chef fixing it and a chef filing a bug.
 */
function parseBlockingIssues(message: string): HealthIssue[] | null {
  const start = message.indexOf('[')
  if (start === -1) return null
  try {
    const parsed = JSON.parse(message.slice(start, message.lastIndexOf(']') + 1))
    if (!Array.isArray(parsed)) return null
    return parsed.map((i) => ({ ...i, severity: 'blocking' as const }))
  } catch {
    return null
  }
}

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
