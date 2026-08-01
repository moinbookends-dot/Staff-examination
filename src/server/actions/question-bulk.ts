'use server'

import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/auth/guards'
import { createClient } from '@/lib/supabase/server'
import { publishIssues } from '@/lib/questions/publish'
import { isDrawableStatus, permissionForStatus } from '@/lib/questions/status'
import { parseQuestionFilters } from '@/lib/questions/filters'
import {
  BULK_LIMIT,
  bulkDeleteSchema,
  bulkPublishSchema,
  bulkUpdateSchema,
  partitionBulkRows,
  type BulkOutcome,
  type BulkRow,
} from '@/lib/questions/bulk'
import type { ValidationIssue } from '@/lib/questions/schemas'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Bulk question operations.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THESE ARE THIN WRAPPERS. THE RULES LIVE IN 0042.                          │
 * │                                                                           │
 * │ No company check, no brand check, no transition check here — the RPCs are │
 * │ SECURITY INVOKER, so 0010's policies scope the rows and                   │
 * │ question_status_transition_allowed() (0040) decides which moves are       │
 * │ legal. Re-checking any of that in TypeScript would be a second opinion,   │
 * │ and the second opinion is the one that eventually disagrees.              │
 * │                                                                           │
 * │ Two things DO belong here: requirePermission, which is the application's  │
 * │ authorisation boundary everywhere else in this codebase, and — for        │
 * │ publishing — the validation that exists only in TypeScript.               │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Change metadata on many questions at once.
 *
 * A drawable status is refused rather than passed through: making a question
 * live runs the publish gate, and that is bulkPublishQuestions' job. Letting it
 * through here would reopen exactly the hole setQuestionStatus had.
 */
export async function bulkUpdateQuestions(input: unknown): Promise<BulkOutcome> {
  const parsed = bulkUpdateSchema.safeParse(input)
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? 'Invalid request.',
      applied: [],
      skipped: [],
    }
  }
  const v = parsed.data

  if (v.status && isDrawableStatus(v.status)) {
    return {
      ok: false,
      error: 'Publishing runs a validation gate — use the publish action.',
      applied: [],
      skipped: [],
    }
  }

  // The same mapping the single-question path uses, so the two cannot diverge.
  await requirePermission(v.status ? permissionForStatus(v.status) : 'questions.update')

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('bulk_update_questions', {
    p_ids: v.ids,
    p_set_status: v.status,
    p_set_category: v.categoryId ?? undefined,
    p_clear_category: v.clearCategory ?? false,
    p_set_difficulty: v.difficulty,
    p_set_bloom: v.bloomLevel,
    p_clear_bloom: v.clearBloom ?? false,
    p_add_tags: v.addTagIds,
    p_remove_tags: v.removeTagIds,
  })

  if (error) return { ok: false, error: 'Could not apply that change.', applied: [], skipped: [] }

  revalidatePath('/questions')
  return { ok: true, ...partitionBulkRows((data ?? []) as unknown as BulkRow[]) }
}

/**
 * Publish many questions.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHY THIS IS NOT A PURE SQL RPC.                                           │
 * │                                                                           │
 * │ publishIssues → validateQuestion is around 120 lines of cross-shape       │
 * │ checking, including compiling a candidate-facing regex for `regex` blanks.│
 * │ Postgres cannot do that faithfully, and reimplementing the rest in plpgsql│
 * │ would be a second copy of the rule deciding whether a question is fit to  │
 * │ be graded against — the drift this codebase has already been bitten by.   │
 * │                                                                           │
 * │ So: two batched reads, the SAME validator the editor and the single-      │
 * │ question path use, then ONE set-based update of the ids that passed.      │
 * │ Structurally what publish_exam does — call the health function, refuse on │
 * │ anything blocking, then mutate as a set.                                  │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export async function bulkPublishQuestions(input: unknown): Promise<BulkOutcome> {
  const parsed = bulkPublishSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: 'Invalid request.', applied: [], skipped: [] }
  }
  const { ids } = parsed.data
  const to = parsed.data.to ?? 'active'

  if (!isDrawableStatus(to)) {
    return { ok: false, error: 'That status does not publish a question.', applied: [], skipped: [] }
  }

  await requirePermission('questions.update')

  const supabase = await createClient()
  // Two reads for any number of questions. RLS scopes both, so a question the
  // caller cannot see simply does not come back — and is reported as skipped
  // rather than silently dropped from the count.
  const [{ data: questions }, { data: keys }] = await Promise.all([
    supabase.from('questions').select('id, content').in('id', ids).is('deleted_at', null),
    supabase.from('question_answer_keys').select('question_id, answer_key').in('question_id', ids),
  ])

  const keyOf = new Map((keys ?? []).map((k) => [k.question_id, k.answer_key]))
  const passing: string[] = []
  const failed: { id: string; issues: ValidationIssue[] }[] = []

  for (const question of questions ?? []) {
    const key = keyOf.get(question.id)
    if (key === undefined) {
      // Only reachable for a question written outside save_question — an
      // import, a seed, psql. Published, it would grade every candidate at zero.
      failed.push({
        id: question.id,
        issues: [{ path: 'answerKey', message: 'This question has no answer key.' }],
      })
      continue
    }
    const issues = publishIssues(question.content, key)
    if (issues.length > 0) failed.push({ id: question.id, issues })
    else passing.push(question.id)
  }

  const unseen = ids
    .filter((id) => !(questions ?? []).some((q) => q.id === id))
    .map((id) => ({ id, reason: 'not found, already removed, or not yours' }))

  if (passing.length === 0) {
    return {
      ok: true,
      applied: [],
      skipped: [...failed.map((f) => ({ id: f.id, reason: 'not ready to publish' })), ...unseen],
      issues: failed.length > 0 ? failed : undefined,
    }
  }

  const { data, error } = await supabase.rpc('bulk_update_questions', {
    p_ids: passing,
    p_set_status: to,
  })
  if (error) return { ok: false, error: 'Could not publish.', applied: [], skipped: [] }

  const result = partitionBulkRows((data ?? []) as unknown as BulkRow[])
  revalidatePath('/questions')
  return {
    ok: true,
    applied: result.applied,
    skipped: [
      ...result.skipped,
      ...failed.map((f) => ({ id: f.id, reason: 'not ready to publish' })),
      ...unseen,
    ],
    issues: failed.length > 0 ? failed : undefined,
  }
}

/**
 * Remove or restore many questions.
 *
 * Restore is reachable only because 0041 added questions_restore. Until then
 * the soft delete was one-way by construction — 0010's policies both carry
 * `deleted_at is null` and an UPDATE's USING is evaluated against the OLD row —
 * so a chef could not even list what they had removed.
 */
export async function bulkSetQuestionsDeleted(input: unknown): Promise<BulkOutcome> {
  const parsed = bulkDeleteSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: 'Invalid request.', applied: [], skipped: [] }
  }
  const { ids, deleted } = parsed.data

  await requirePermission('questions.retire')

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('bulk_set_question_deleted', {
    p_ids: ids,
    p_deleted: deleted,
  })
  if (error) {
    return {
      ok: false,
      error: deleted ? 'Could not remove those questions.' : 'Could not restore those questions.',
      applied: [],
      skipped: [],
    }
  }

  revalidatePath('/questions')
  return { ok: true, ...partitionBulkRows((data ?? []) as unknown as BulkRow[]) }
}

/**
 * Every id matching a filter, for "select all 340".
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ RESOLVED THROUGH THE SAME PREDICATES THAT RENDER THE LIST.                │
 * │                                                                           │
 * │ The alternative — passing the filter into the RPC and repeating the WHERE │
 * │ clause in SQL — would be a second definition of what a filter means, and  │
 * │ the two would disagree the first time a filter was added to one of them.  │
 * │ Ids cost one indexed read and are unambiguous about what was selected.    │
 * │                                                                           │
 * │ The cap is REPORTED, not silently applied: a chef who asked for 4,000 and │
 * │ changed 1,000 has to be told which of those happened.                     │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export async function resolveFilterToIds(
  input: unknown,
): Promise<{ ids: string[]; total: number; capped: boolean }> {
  await requirePermission('questions.read')

  const filters = parseQuestionFilters(input)
  const supabase = await createClient()

  let query = supabase.from('questions').select('id', { count: 'exact' })

  query = filters.deleted ? query.not('deleted_at', 'is', null) : query.is('deleted_at', null)

  // Identical to listQuestions. A filter added there and not here means
  // "select all matching" quietly selects more than the screen showed.
  if (filters.status) query = query.eq('status', filters.status)
  if (filters.type) query = query.eq('type', filters.type)
  if (filters.categoryId) query = query.eq('category_id', filters.categoryId)
  if (filters.difficulty) query = query.eq('difficulty', filters.difficulty)
  if (filters.bloomLevel) query = query.eq('bloom_level', filters.bloomLevel)
  if (filters.source) query = query.eq('source', filters.source)
  if (filters.q) {
    query = query.textSearch('search_tsv', filters.q, { type: 'websearch', config: 'simple' })
  }

  // The SAME order as listQuestions, tiebreak included. It matters because the
  // cap is a limit: when a filter matches more than BULK_LIMIT, "select all
  // matching" holds the FIRST 1,000 in this order, and if that order differed
  // from the screen's, the 1,000 it kept would not be the 1,000 anybody saw.
  const { data, error, count } = await query
    .order(filters.sort, { ascending: filters.dir === 'asc' })
    .order('id', { ascending: true })
    .limit(BULK_LIMIT)

  if (error) return { ids: [], total: 0, capped: false }

  const ids = (data ?? []).map((row) => row.id)
  return { ids, total: count ?? ids.length, capped: (count ?? 0) > BULK_LIMIT }
}
