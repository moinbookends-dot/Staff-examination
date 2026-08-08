'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { getAppClaims } from '@/lib/auth/claims'
import { canEditQuestions, canOpenQuestionBank } from '@/lib/auth/bank-access'
import { createClient } from '@/lib/supabase/server'
import { dbId } from '@/lib/db/id'
import { topicSlug } from '@/lib/bank/import/format'
import { TOPIC_MAX_LENGTH } from '@/lib/bank/vocabulary'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Topic management.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ TOPICS ARE LABELS. NOTHING DOWNSTREAM READS ONE.                          │
 * │                                                                           │
 * │ generate_exam_paper does not consult a topic, no paper prints one, and no │
 * │ count, quota or ratio is expressed in topics. That is exactly why Editors │
 * │ may manage them freely: renaming, adding or retiring a topic cannot       │
 * │ change a single generated paper.                                          │
 * │                                                                           │
 * │ Contrast difficulty and status, which are enums precisely BECAUSE the     │
 * │ generator names them.                                                     │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */

export type TopicResult =
  | { ok: true; id: string }
  | { ok: false; message: string }

const topicInput = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Give the topic a name.')
    .max(TOPIC_MAX_LENGTH, `Keep the name under ${TOPIC_MAX_LENGTH} characters.`),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
})

async function guard() {
  const claims = await getAppClaims()
  if (!canOpenQuestionBank(claims) || !canEditQuestions(claims)) return null
  if (!claims.company_id) return null
  return claims
}

const DENIED = 'Topics are managed by Editors only.'

export async function createTopic(raw: unknown): Promise<TopicResult> {
  const claims = await guard()
  if (!claims?.company_id) return { ok: false, message: DENIED }

  const parsed = topicInput.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Check the topic.' }
  }

  const supabase = await createClient()

  /*
   * The slug is derived, never typed.
   *
   * It is the stable handle an import file names a topic by, so it has to be
   * produced by the SAME function the importer uses to match one — otherwise
   * "Food Safety" created here and "Food Safety" in a spreadsheet resolve to
   * different slugs and the import reports an unknown topic for a topic that
   * plainly exists.
   */
  const slug = topicSlug(parsed.data.name)
  if (!slug) return { ok: false, message: 'That name has no letters or numbers in it.' }

  const { data, error } = await supabase
    .from('question_topics')
    .insert({
      company_id: claims.company_id,
      name: parsed.data.name,
      slug,
      sort_order: parsed.data.sortOrder,
    })
    .select('id')
    .single()

  if (error) {
    // 23505 on (company_id, slug) where deleted_at is null.
    if (error.code === '23505') {
      return { ok: false, message: 'A topic with that name already exists.' }
    }
    return { ok: false, message: 'Could not create the topic. Try again.' }
  }

  revalidatePath('/questions/topics')
  revalidatePath('/questions')
  return { ok: true, id: data.id }
}

export async function updateTopic(id: unknown, raw: unknown): Promise<TopicResult> {
  const claims = await guard()
  if (!claims) return { ok: false, message: DENIED }

  const topicId = dbId().safeParse(id)
  if (!topicId.success) return { ok: false, message: 'That topic could not be found.' }

  const parsed = topicInput.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Check the topic.' }
  }

  const slug = topicSlug(parsed.data.name)
  if (!slug) return { ok: false, message: 'That name has no letters or numbers in it.' }

  const supabase = await createClient()

  /*
   * Counted, because RLS refuses by FILTERING. An update the policies do not
   * admit returns error null having changed nothing, and code that checks only
   * `error` reports a rename that never happened.
   */
  const { error, count } = await supabase
    .from('question_topics')
    .update(
      { name: parsed.data.name, slug, sort_order: parsed.data.sortOrder },
      { count: 'exact' },
    )
    .eq('id', topicId.data)

  if (error) {
    if (error.code === '23505') {
      return { ok: false, message: 'A topic with that name already exists.' }
    }
    return { ok: false, message: 'Could not update the topic. Try again.' }
  }
  if (count !== 1) return { ok: false, message: 'That topic could not be changed.' }

  revalidatePath('/questions/topics')
  revalidatePath('/questions')
  return { ok: true, id: topicId.data }
}

/**
 * Archive or restore.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ ARCHIVING IS deleted_at, AND THERE IS NO HARD DELETE.                     │
 * │                                                                           │
 * │ bank_questions.topic_id is ON DELETE RESTRICT, so removing a topic that   │
 * │ questions are filed under would be refused by a foreign key — and a       │
 * │ foreign-key violation is a poor way to tell an Editor "forty questions    │
 * │ use this".                                                                │
 * │                                                                           │
 * │ Setting deleted_at stops it being offered on new questions while the ones │
 * │ already filed under it keep their label. 0053 grants no DELETE policy at  │
 * │ all, so this is not merely the convention — it is the only thing that     │
 * │ works.                                                                    │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export async function setTopicArchived(id: unknown, archived: boolean): Promise<TopicResult> {
  const claims = await guard()
  if (!claims) return { ok: false, message: DENIED }

  const topicId = dbId().safeParse(id)
  if (!topicId.success) return { ok: false, message: 'That topic could not be found.' }

  const supabase = await createClient()

  const { error, count } = await supabase
    .from('question_topics')
    .update({ deleted_at: archived ? new Date().toISOString() : null }, { count: 'exact' })
    .eq('id', topicId.data)

  if (error) return { ok: false, message: 'Could not change the topic. Try again.' }
  if (count !== 1) return { ok: false, message: 'That topic could not be changed.' }

  revalidatePath('/questions/topics')
  revalidatePath('/questions')
  return { ok: true, id: topicId.data }
}
