'use server'

import { revalidatePath } from 'next/cache'
import { requirePermission } from '@/lib/auth/guards'
import { createClient } from '@/lib/supabase/server'
import {
  deleteFilterSchema,
  saveFilterSchema,
  type SavedFilter,
} from '@/lib/questions/saved-filters'

/**
 * A chef's own saved question-bank filters (0043).
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE PERMISSION HERE IS questions.read, AND THAT IS THE WHOLE STORY.       │
 * │                                                                           │
 * │ Not because saved filters are unimportant, but because they are not       │
 * │ company data: 0043's policies are `owner_id = auth.uid()` with no         │
 * │ has_perm escape and no admin read. There is no second, narrower           │
 * │ permission to invent — anyone who can look at the bank may keep notes     │
 * │ about how they look at it, and nobody, including a Super Admin, can read  │
 * │ anybody else's.                                                           │
 * │                                                                           │
 * │ So requirePermission is doing one job: keeping people who cannot see the  │
 * │ bank at all out of the table. RLS does the rest, and these functions      │
 * │ re-check none of it.                                                      │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

export async function listSavedFilters(): Promise<SavedFilter[]> {
  await requirePermission('questions.read')

  const supabase = await createClient()
  const { data, error } = await supabase
    .from('question_saved_filters')
    .select('id, name, query')
    .order('name')

  if (error) return []
  return data ?? []
}

/**
 * Save, or overwrite a filter of the same name.
 *
 * Upsert rather than insert because 0043 carries `unique (owner_id, name)`, and
 * the alternative is asking a chef to delete "Needs Bloom" before they can
 * update "Needs Bloom" — which is a dialog explaining a constraint rather than
 * a feature.
 */
export async function saveFilter(input: unknown): Promise<{ ok: boolean; error?: string }> {
  const claims = await requirePermission('questions.read')

  const parsed = saveFilterSchema.safeParse(input)
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? 'Invalid request.' }
  }

  // Both come from the verified `app` claim, never from the client. The policy
  // asserts the same two things in its WITH CHECK, so a mismatch is refused by
  // the database rather than merely by this line.
  if (!claims.userId || !claims.company_id) {
    return { ok: false, error: 'Your account is not attached to a company yet.' }
  }

  const supabase = await createClient()
  const { error } = await supabase.from('question_saved_filters').upsert(
    {
      owner_id: claims.userId,
      company_id: claims.company_id,
      name: parsed.data.name,
      query: parsed.data.query,
    },
    { onConflict: 'owner_id,name' },
  )

  if (error) return { ok: false, error: 'Could not save that filter.' }

  revalidatePath('/questions')
  return { ok: true }
}

export async function deleteSavedFilter(input: unknown): Promise<{ ok: boolean; error?: string }> {
  await requirePermission('questions.read')

  const parsed = deleteFilterSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'Invalid request.' }

  const supabase = await createClient()
  // RLS scopes this to the caller's own rows, so a filter belonging to somebody
  // else matches nothing. The count is checked for the same reason
  // deleteQuestion checks it: a refusal returns zero rows, not an error, and
  // reporting success for a delete that did not happen is its own bug.
  const { error, count } = await supabase
    .from('question_saved_filters')
    .delete({ count: 'exact' })
    .eq('id', parsed.data.id)

  if (error) return { ok: false, error: 'Could not remove that filter.' }
  if (count === 0) return { ok: false, error: 'That filter could not be removed.' }

  revalidatePath('/questions')
  return { ok: true }
}
