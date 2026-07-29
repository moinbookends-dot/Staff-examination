'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/auth/guards'
import { createClient } from '@/lib/supabase/server'
import { dbId } from '@/lib/db/id'
import { translationContentSchema, LOCALES } from '@/lib/questions/translation'
import type { TranslationContent, Locale, TranslationStatus } from '@/lib/questions/translation'
import type { QuestionContentDraft, ResponseFormat } from '@/lib/questions/schemas'
import type { MutationResult } from './questions'

/**
 * Question translations.
 *
 * A separate file from questions.ts, which is already long and opens with a
 * module doc asserting one security posture. This one has a different
 * permission and a different validation surface.
 *
 * READS gate on questions.read, WRITES on questions.translate — asymmetric on
 * purpose, so somebody auditing the bank can see what has been translated
 * without being able to change what it says.
 *
 * The user's client throughout, as everywhere else: 0031 scopes these tables to
 * the caller's company, and an admin client would discard exactly the predicate
 * that milestone added.
 */

export interface QuestionTranslation {
  locale: Locale
  stem: string
  content: TranslationContent
  explanation: string | null
  status: TranslationStatus
  source: 'human' | 'ai'
  base_revision: number
  /** The question has been reworded since this was written. */
  stale: boolean
  translated_by_name: string | null
  reviewed_by_name: string | null
  updated_at: string
}

export interface TranslationWorkbench {
  question: {
    id: string
    stem: string
    content: QuestionContentDraft
    response_format: ResponseFormat
    revision: number
  }
  translations: QuestionTranslation[]
}

/**
 * The base question and every translation of it.
 *
 * Returns null for a question the caller cannot see, which 0031 makes
 * indistinguishable from one that does not exist — the page turns either into
 * a 404, as the question editor already does.
 */
export async function getTranslationWorkbench(
  questionId: string,
): Promise<TranslationWorkbench | null> {
  await requirePermission('questions.read')

  const parsed = dbId().safeParse(questionId)
  if (!parsed.success) return null

  const supabase = await createClient()

  const { data: question, error } = await supabase
    .from('questions')
    .select('id, stem, content, response_format, revision')
    .eq('id', parsed.data)
    .is('deleted_at', null)
    .maybeSingle()

  if (error || !question) return null

  const { data: rows } = await supabase
    .from('question_translations')
    .select('locale, stem, content, explanation, status, source, base_revision, translated_by, reviewed_by, updated_at')
    .eq('question_id', parsed.data)

  // Names fetched separately: question_translations has no generated FK
  // relationship to profiles, and hard-coding the constraint name into an
  // embedded select is a brittle thing to depend on.
  const ids = [
    ...new Set((rows ?? []).flatMap((r) => [r.translated_by, r.reviewed_by]).filter(Boolean)),
  ] as string[]

  const { data: people } = ids.length
    ? await supabase.from('profiles').select('id, full_name').in('id', ids)
    : { data: [] }

  const nameOf = new Map((people ?? []).map((p) => [p.id, p.full_name ?? '']))

  return {
    question: {
      id: question.id,
      stem: question.stem,
      content: question.content as unknown as QuestionContentDraft,
      response_format: question.response_format as ResponseFormat,
      revision: question.revision,
    },
    translations: (rows ?? []).map((r) => ({
      locale: r.locale as Locale,
      stem: r.stem,
      content: (r.content ?? {}) as TranslationContent,
      explanation: r.explanation,
      status: r.status as TranslationStatus,
      source: r.source as 'human' | 'ai',
      base_revision: r.base_revision,
      // The comparison 0032's column exists for: a published translation of
      // wording that no longer exists is worse than none, because it is
      // delivered with more confidence than the English.
      stale: r.base_revision < question.revision,
      translated_by_name: r.translated_by ? (nameOf.get(r.translated_by) ?? null) : null,
      reviewed_by_name: r.reviewed_by ? (nameOf.get(r.reviewed_by) ?? null) : null,
      updated_at: r.updated_at,
    })),
  }
}

const saveSchema = z.object({
  questionId: dbId(),
  locale: z.enum(LOCALES),
  stem: z.string().trim().min(1, 'The question needs a translation.').max(4000),
  content: translationContentSchema,
  explanation: z.string().max(4000).optional(),
  status: z.enum(['draft', 'review', 'published']).default('draft'),
  /** Optimistic concurrency — two translators on one row is a real collision. */
  expectedUpdatedAt: z.string().optional(),
})

/**
 * Saves one locale of one question.
 *
 * Every rule that matters — the review workflow, agreement with the base row,
 * the presentation-only shape — is enforced by 0032, not here. This parses,
 * calls, and reports. Restating the workflow in TypeScript would give it two
 * homes and one of them would drift.
 */
export async function saveQuestionTranslation(input: unknown): Promise<MutationResult> {
  await requirePermission('questions.translate')

  const parsed = saveSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'That translation could not be read.' }
  }
  const v = parsed.data

  const supabase = await createClient()
  const { error } = await supabase.rpc('save_question_translation', {
    p_question_id: v.questionId,
    p_locale: v.locale,
    p_stem: v.stem,
    p_content: v.content,
    p_explanation: v.explanation ?? null,
    p_status: v.status,
    p_source: 'human',
    p_expected_updated_at: v.expectedUpdatedAt ?? null,
  })

  if (error) {
    // 42501 conflates "no such question", "another company's" and "not
    // permitted" on purpose, exactly as saveQuestion does.
    if (error.code === '42501') return { ok: false, error: 'You cannot translate that question.' }
    return { ok: false, error: error.message.replace(/^.*?:\s*/, '') }
  }

  revalidatePath(`/questions/${v.questionId}/translations`)
  return { ok: true }
}
