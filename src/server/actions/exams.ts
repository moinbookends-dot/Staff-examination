'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/auth/guards'
import { createClient } from '@/lib/supabase/server'
import { dbId } from '@/lib/db/id'
import { examFiltersSchema, EXAMS_PAGE_SIZE } from '@/lib/exams/filters'
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

/**
 * What this exam asks.
 *
 * The frozen paper when one exists, otherwise a representative draw flagged
 * `is_preview`. One call either way — a chef asks the same question of a draft
 * and a published exam, and making them reason about which storage backs it
 * would serve the schema rather than the person.
 */
export async function getExamPaper(examId: string): Promise<PaperQuestion[]> {
  await requirePermission('exams.read')

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('exam_paper', {
    p_exam_id: examId,
    p_seed: null,
  })

  if (error) return []
  return (data ?? []) as unknown as PaperQuestion[]
}

export interface RuleCount {
  rule_id: string
  /** How many questions this rule matches on its own, within its difficulty band. */
  available: number
  /** How many it actually gets once earlier rules have taken theirs. */
  drawn: number
}

/**
 * The two numbers the builder shows beside each saved rule.
 *
 * `available` alone would be a trap: two rules can match the same questions, and
 * the second only discovers at publish that the first took them. Showing both
 * turns "your exam is short" at publish time into "19 of these are already
 * taken" while the chef is still editing.
 */
export async function getRuleCounts(examId: string): Promise<RuleCount[]> {
  await requirePermission('exams.read')

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('exam_rule_counts', { p_exam_id: examId })
  if (error) return []
  return (data ?? []) as unknown as RuleCount[]
}

const previewSchema = z.object({
  examId: dbId(),
  categoryId: dbId().nullable().default(null),
  includeSubcategories: z.boolean().default(true),
  tagIds: z.array(dbId()).default([]),
  difficultyMin: z.number().int().min(1).max(5).default(1),
  difficultyMax: z.number().int().min(1).max(5).default(5),
})

/**
 * How many questions an UNSAVED rule would match.
 *
 * Only the `available` half: a rule with no position in the running order has
 * no meaningful `drawn`, and inventing one would be worse than omitting it.
 */
export async function previewRuleCount(input: unknown): Promise<number | null> {
  await requirePermission('exams.read')

  const parsed = previewSchema.safeParse(input)
  if (!parsed.success) return null

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('preview_rule_count', {
    p_exam_id: parsed.data.examId,
    p_category_id: parsed.data.categoryId,
    p_include_sub: parsed.data.includeSubcategories,
    p_tag_ids: parsed.data.tagIds,
    p_types: null,
    p_difficulty_min: parsed.data.difficultyMin,
    p_difficulty_max: parsed.data.difficultyMax,
  })

  if (error) return null
  return data as unknown as number
}

// ─────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `sections` is OPTIONAL, and the distinction matters.
 *
 * Omitted  → the section tree is left exactly as it is.
 * Provided → it is replaced wholesale, empty array included.
 *
 * Without that split, the settings form — which knows nothing about sections —
 * would delete the entire paper structure every time somebody corrected a
 * typo in the title. Defaulting to `[]` would make silent data loss the
 * default behaviour.
 */
const saveExamSchema = examSchema.extend({
  sections: z.array(examSectionSchema).optional(),
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

  // Nothing further to do for a caller that only touched the settings.
  if (v.sections === undefined) {
    revalidatePath('/exams')
    revalidatePath(`/exams/${examId}`)
    return { ok: true, id: examId }
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

const saveSectionsSchema = z.object({
  examId: dbId(),
  sections: z.array(examSectionSchema),
})

/**
 * Replace an exam's section tree, without touching its settings.
 *
 * Separate from saveExam because the two are edited by different forms and
 * neither should have to restate the other's fields. Routing a sections-only
 * save through saveExam would mean sending a title the section builder does not
 * own, which is how a form ends up writing back a stale copy of something
 * somebody else just changed.
 */
export async function saveSections(input: unknown): Promise<MutationResult> {
  await requirePermission('exams.update')

  const parsed = saveSectionsSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid sections.' }
  }

  const { examId, sections } = parsed.data
  const supabase = await createClient()

  // Replace-set: the builder sends the whole tree, so a merge would make
  // deleting a rule impossible. Rules cascade with their section.
  const { error: wipeError } = await supabase.from('exam_sections').delete().eq('exam_id', examId)
  if (wipeError) return { ok: false, error: friendlyWriteError(wipeError) }

  for (const [index, section] of sections.entries()) {
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

  revalidatePath(`/exams/${examId}`)
  return { ok: true }
}

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
        target_user_id: a.targetUserId,
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
