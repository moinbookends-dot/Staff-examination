'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/auth/guards'
import { createClient } from '@/lib/supabase/server'
import type { Database } from '@/lib/db/database.types'
import { dbId } from '@/lib/db/id'
import { publishIssues } from '@/lib/questions/publish'
import { questionStatusSchema } from '@/lib/questions/status'
import {
  parseQuestionFilters,
  QUESTIONS_PAGE_SIZE,
  type QuestionFilters,
} from '@/lib/questions/filters'
import {
  questionContentDraftSchema,
  answerKeySchema,
  questionTypeSchema,
  responseFormatSchema,
  formatAllowedForType,
  type QuestionType,
  type ResponseFormat,
  type ValidationIssue,
} from '@/lib/questions/schemas'
import type { Json } from '@/lib/db/database.types'

/**
 * The question bank's write and read paths.
 *
 * EVERY QUERY HERE USES THE USER'S CLIENT, NOT THE ADMIN CLIENT.
 *
 * That is the whole security design of this module. The admin client bypasses
 * RLS, so using it would mean company scoping, brand scoping and the answer-key
 * lockdown all depend on remembering to add the right `.eq()` by hand, in every
 * function, forever. With the user's client, migration 0010's policies do that
 * work and a forgotten filter returns too few rows rather than someone else's.
 *
 * users.ts uses the admin client deliberately, for one reason that does not
 * apply here: a chef holds users.approve but not users.update, so the policy
 * would refuse a write the application has authorised. Nothing in this file has
 * that shape.
 */

export interface MutationResult {
  ok: boolean
  error?: string
  /** Populated by publishQuestion when the strict gate refuses. */
  issues?: ValidationIssue[]
}

export type QuestionStatus = Database['public']['Enums']['question_status']
export type BloomTaxonomy = Database['public']['Enums']['bloom_taxonomy']
export type QuestionSource = 'manual' | 'import' | 'ai'

export interface QuestionListItem {
  id: string
  stem: string
  type: QuestionType
  response_format: ResponseFormat
  status: QuestionStatus
  difficulty: number
  marks: number
  revision: number
  usage_count: number
  category_id: string | null
  category_name: string | null
  bloom_level: BloomTaxonomy | null
  source: QuestionSource
  imported_from: string | null
  updated_at: string
}

export interface QuestionDetail {
  id: string
  stem: string
  type: QuestionType
  response_format: ResponseFormat
  status: QuestionStatus
  content: unknown
  answerKey: unknown
  brand_id: string | null
  category_id: string | null
  difficulty: number
  marks: number
  negative_marks: number
  estimated_seconds: number | null
  explanation: string | null
  reference_note: string | null
  revision: number
  tagIds: string[]
  bloom_level: BloomTaxonomy | null
  source: QuestionSource
  imported_from: string | null
}

export interface QuestionRevisionEntry {
  revision: number
  edited_at: string
  change_note: string | null
  editor_name: string | null
}

export interface CategoryOption {
  id: string
  name: string
  parent_id: string | null
}

export interface TagOption {
  id: string
  name: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Reads
// ─────────────────────────────────────────────────────────────────────────────

export async function listQuestions(
  input: unknown,
): Promise<{ items: QuestionListItem[]; total: number; page: number; pageSize: number }> {
  await requirePermission('questions.read')

  const filters: QuestionFilters = parseQuestionFilters(input)
  const from = (filters.page - 1) * QUESTIONS_PAGE_SIZE

  const supabase = await createClient()
  let query = supabase
    .from('questions')
    .select(
      'id, stem, type, response_format, status, difficulty, marks, revision, usage_count, category_id, bloom_level, source, imported_from, updated_at, categories(name)',
      { count: 'exact' },
    )
    .is('deleted_at', null)

  if (filters.status) query = query.eq('status', filters.status)
  if (filters.type) query = query.eq('type', filters.type)
  if (filters.categoryId) query = query.eq('category_id', filters.categoryId)
  if (filters.difficulty) query = query.eq('difficulty', filters.difficulty)

  if (filters.q) {
    // 'simple' matches the config the search_tsv generated column was built
    // with (migration 0009). Passing the default 'english' here would stem the
    // query but not the index, so "knives" would stop matching "knife" — a
    // search that silently returns fewer results than it should.
    query = query.textSearch('search_tsv', filters.q, { type: 'websearch', config: 'simple' })
  }

  const { data, error, count } = await query
    .order('updated_at', { ascending: false })
    .range(from, from + QUESTIONS_PAGE_SIZE - 1)

  if (error) return { items: [], total: 0, page: filters.page, pageSize: QUESTIONS_PAGE_SIZE }

  const items = (data ?? []).map((row) => {
    const { categories, ...rest } = row as typeof row & {
      categories: { name: string } | { name: string }[] | null
    }
    const category = Array.isArray(categories) ? categories[0] : categories
    return { 
      ...rest, 
      category_name: category?.name ?? null,
      source: rest.source as QuestionSource
    } as QuestionListItem
  })

  return { items, total: count ?? 0, page: filters.page, pageSize: QUESTIONS_PAGE_SIZE }
}

/**
 * One question with its answer key.
 *
 * The key is fetched through the user's client, so answer_keys_read is the
 * gate: `questions.read` plus same company. An employee reaching this function
 * would get `answerKey: null` rather than an exception — but they cannot reach
 * it, because requirePermission refuses first. Two independent layers, as with
 * every other path to the keys.
 */
export async function getQuestion(id: string): Promise<QuestionDetail | null> {
  await requirePermission('questions.read')

  const supabase = await createClient()
  const [{ data: question }, { data: key }, { data: tags }] = await Promise.all([
    supabase.from('questions').select('*').eq('id', id).is('deleted_at', null).maybeSingle(),
    supabase.from('question_answer_keys').select('answer_key').eq('question_id', id).maybeSingle(),
    supabase.from('question_tags').select('tag_id').eq('question_id', id),
  ])

  if (!question) return null

  return {
    id: question.id,
    stem: question.stem,
    type: question.type,
    response_format: question.response_format,
    status: question.status,
    content: question.content,
    answerKey: key?.answer_key ?? null,
    brand_id: question.brand_id,
    category_id: question.category_id,
    difficulty: question.difficulty,
    marks: Number(question.marks),
    negative_marks: Number(question.negative_marks),
    estimated_seconds: question.estimated_seconds,
    explanation: question.explanation,
    reference_note: question.reference_note,
    revision: question.revision ?? 1,
    tagIds: tags?.map((t) => t.tag_id) ?? [],
    bloom_level: question.bloom_level,
    source: question.source as QuestionSource,
    imported_from: question.imported_from,
  }
}

/** Revision history for the editor's History tab. Newest first. */
export async function listQuestionRevisions(id: string): Promise<QuestionRevisionEntry[]> {
  await requirePermission('questions.read')

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('question_revisions')
    .select('revision, edited_at, change_note, profiles:edited_by(full_name)')
    .eq('question_id', id)
    .order('revision', { ascending: false })

  if (error) return []

  return (data ?? []).map((row) => {
    const { profiles, ...rest } = row as typeof row & {
      profiles: { full_name: string } | { full_name: string }[] | null
    }
    const editor = Array.isArray(profiles) ? profiles[0] : profiles
    return { ...rest, editor_name: editor?.full_name ?? null }
  })
}

export async function listCategories(): Promise<CategoryOption[]> {
  await requirePermission('questions.read')

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('categories')
    .select('id, name, parent_id')
    .is('deleted_at', null)
    .order('sort_order')
    .order('name')

  if (error) return []
  return data as CategoryOption[]
}

export async function listTags(): Promise<TagOption[]> {
  await requirePermission('questions.read')

  const supabase = await createClient()
  const { data, error } = await supabase.from('tags').select('id, name').order('name')

  if (error) return []
  return data as TagOption[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Writes
// ─────────────────────────────────────────────────────────────────────────────

const saveSchema = z
  .object({
    id: dbId().nullable().default(null),
    type: questionTypeSchema,
    responseFormat: responseFormatSchema,
    stem: z.string().trim().min(3, 'Give the question at least a few words.').max(4000),
    // DRAFT schema, not the strict one. Saving a half-written question must
    // work — the strict gate belongs to publishing, not to Save.
    content: questionContentDraftSchema,
    answerKey: answerKeySchema,
    brandId: dbId().nullable().default(null),
    categoryId: dbId().nullable().default(null),
    difficulty: z.number().int().min(1).max(5).default(3),
    marks: z.number().positive().max(9999).default(1),
    negativeMarks: z.number().min(0).max(9999).default(0),
    estimatedSeconds: z.number().int().min(5).max(3600).nullable().default(null),
    explanation: z.string().trim().max(4000).nullable().default(null),
    referenceNote: z.string().trim().max(1000).nullable().default(null),
    tagIds: z.array(dbId()).default([]),
    changeNote: z.string().trim().max(300).nullable().default(null),
  })
  // Mirrors the q_format_matches_type CHECK in migration 0009. Caught here so
  // the chef reads "True/False questions must use the boolean format" instead
  // of a raw constraint violation.
  .refine((v) => formatAllowedForType(v.type, v.responseFormat), {
    path: ['responseFormat'],
    message: 'That response format is not available for this question type.',
  })
  // The editor keeps content and key in step; this catches a hand-built or
  // stale payload before it reaches a table where the two live apart and
  // nothing would notice.
  .refine((v) => v.content.format === v.responseFormat && v.answerKey.format === v.responseFormat, {
    path: ['content'],
    message: 'Content and answer key do not match the selected format.',
  })

export type SaveQuestionInput = z.input<typeof saveSchema>

export async function saveQuestion(
  input: unknown,
): Promise<MutationResult & { id?: string; revision?: number }> {
  const parsed = saveSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid question.' }
  }

  const v = parsed.data
  // Creating and editing are different permissions, and a role can hold one
  // without the other — questions.create without questions.update would be an
  // odd grant, the reverse (edit but not author) is not.
  await requirePermission(v.id ? 'questions.update' : 'questions.create')

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('save_question', {
    p_id: v.id,
    p_type: v.type,
    p_response_format: v.responseFormat,
    p_stem: v.stem,
    p_content: v.content as unknown as Json,
    p_answer_key: v.answerKey as unknown as Json,
    p_brand_id: v.brandId,
    p_category_id: v.categoryId,
    p_difficulty: v.difficulty,
    p_marks: v.marks,
    p_negative_marks: v.negativeMarks,
    p_estimated_seconds: v.estimatedSeconds,
    p_explanation: v.explanation,
    p_reference_note: v.referenceNote,
    p_tag_ids: v.tagIds,
    p_change_note: v.changeNote,
  })

  if (error) {
    // The RPC raises 42501 for "not found or not editable", which conflates
    // wrong-company, deleted and no-permission on purpose — distinguishing them
    // would confirm to a caller that a question they cannot see exists.
    return {
      ok: false,
      error:
        error.code === '42501'
          ? 'You cannot edit that question.'
          : 'Could not save this question.',
    }
  }

  const row = (data as { id: string; revision: number }[] | null)?.[0]

  revalidatePath('/questions')
  if (row?.id) revalidatePath(`/questions/${row.id}`)
  return { ok: true, id: row?.id, revision: row?.revision }
}

/**
 * Activate a question.
 *
 * Re-reads content and key FROM THE DATABASE and validates those, never a
 * payload the caller supplied. The editor runs the identical check to decide
 * whether to enable the button, but a client that skipped the editor could send
 * a valid-looking body alongside a broken stored question — and this is the one
 * transition after which candidates are graded against the key.
 */
export async function publishQuestion(id: string): Promise<MutationResult> {
  await requirePermission('questions.update')

  const supabase = await createClient()
  const [{ data: question }, { data: key }] = await Promise.all([
    supabase.from('questions').select('id, content, status').eq('id', id).is('deleted_at', null).maybeSingle(),
    supabase.from('question_answer_keys').select('answer_key').eq('question_id', id).maybeSingle(),
  ])

  if (!question) return { ok: false, error: 'That question no longer exists.' }
  if (!key) {
    // Possible only if a question was written outside save_question — an
    // import, a seed, psql. It would grade every candidate at zero.
    return { ok: false, error: 'This question has no answer key and cannot be published.' }
  }

  const issues = publishIssues(question.content, key.answer_key)
  if (issues.length > 0) {
    return { ok: false, error: 'This question is not ready to publish.', issues }
  }

  const { error } = await supabase.from('questions').update({ status: 'active' }).eq('id', id)
  if (error) return { ok: false, error: 'Could not publish this question.' }

  revalidatePath('/questions')
  revalidatePath(`/questions/${id}`)
  return { ok: true }
}

const statusSchema = z.object({
  id: dbId(),
  status: questionStatusSchema,
})

/**
 * Retire, or return a retired question to draft.
 *
 * Status changes deliberately do NOT bump the revision — migration 0011 lists
 * status among the excluded columns. Retiring is not a different question, and
 * bumping would fragment its analytics for a filing decision.
 *
 * Retire never goes straight back to active: a question pulled from circulation
 * gets re-read before it returns, which is what draft is for.
 */
export async function setQuestionStatus(input: unknown): Promise<MutationResult> {
  const parsed = statusSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Invalid status.' }

  const { id, status } = parsed.data
  if (status === 'active') {
    return publishQuestion(id)
  }
  await requirePermission('questions.retire')

  const supabase = await createClient()
  const { error } = await supabase
    .from('questions')
    .update({ status })
    .eq('id', id)
    .is('deleted_at', null)

  if (error) return { ok: false, error: 'Could not change the status.' }

  revalidatePath('/questions')
  revalidatePath(`/questions/${id}`)
  return { ok: true }
}

/**
 * Soft delete.
 *
 * There is no DELETE policy on `questions` anywhere — by design (migration
 * 0010). A question referenced by a past attempt must never vanish or the
 * results that cite it become unexplainable. This is an UPDATE setting
 * deleted_at, and the update policy's `deleted_at is null` clause makes it
 * one-way from the application.
 */
export async function deleteQuestion(id: string): Promise<MutationResult> {
  await requirePermission('questions.retire')

  const supabase = await createClient()
  const { error } = await supabase
    .from('questions')
    .update({ deleted_at: new Date().toISOString() })
    .eq('id', id)
    .is('deleted_at', null)

  if (error) return { ok: false, error: 'Could not remove this question.' }

  revalidatePath('/questions')
  return { ok: true }
}

// ─────────────────────────────────────────────────────────────────────────────
// Taxonomy
//
// Inline creation, from inside the editor. A chef mid-question who needs a
// "Allergens" tag will otherwise either abandon the draft to go and make one,
// or skip tagging — and an untagged bank cannot be filtered, which is what the
// M3 exam builder's rule-based selection runs on.
// ─────────────────────────────────────────────────────────────────────────────

/** "Knife Skills" → "knife-skills". Ids stay stable if the name is edited. */
function slugify(name: string): string {
  return name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

const categorySchema = z.object({
  name: z.string().trim().min(2, 'Give the category a name.').max(80),
  parentId: dbId().nullable().default(null),
})

export async function createCategory(
  input: unknown,
): Promise<MutationResult & { category?: CategoryOption }> {
  const claims = await requirePermission('questions.update')

  const parsed = categorySchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid category.' }
  }
  if (!claims.company_id) return { ok: false, error: 'No company on your account.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('categories')
    .insert({
      company_id: claims.company_id,
      parent_id: parsed.data.parentId,
      name: parsed.data.name,
      slug: slugify(parsed.data.name),
    })
    .select('id, name, parent_id')
    .single()

  if (error) {
    // categories_slug_uq. Two chefs adding "Allergens" at once is ordinary, not
    // an error worth a stack trace.
    return {
      ok: false,
      error: error.code === '23505' ? 'A category with that name already exists.' : 'Could not create it.',
    }
  }

  revalidatePath('/questions')
  return { ok: true, category: data as CategoryOption }
}

const tagSchema = z.object({ name: z.string().trim().min(2, 'Give the tag a name.').max(60) })

export async function createTag(input: unknown): Promise<MutationResult & { tag?: TagOption }> {
  const claims = await requirePermission('questions.update')

  const parsed = tagSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid tag.' }
  }
  if (!claims.company_id) return { ok: false, error: 'No company on your account.' }

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('tags')
    .insert({
      company_id: claims.company_id,
      name: parsed.data.name,
      slug: slugify(parsed.data.name),
    })
    .select('id, name')
    .single()

  if (error) {
    return {
      ok: false,
      error: error.code === '23505' ? 'That tag already exists.' : 'Could not create it.',
    }
  }

  return { ok: true, tag: data as TagOption }
}
