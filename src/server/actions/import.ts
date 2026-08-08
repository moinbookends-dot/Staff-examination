'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { getAppClaims } from '@/lib/auth/claims'
import { canEditQuestions, canOpenQuestionBank } from '@/lib/auth/bank-access'
import { createClient } from '@/lib/supabase/server'
import { dbId } from '@/lib/db/id'
import { IMPORT_BATCH_SIZE } from '@/lib/bank/import/commit'
import { DIFFICULTIES, QUESTION_STATUSES, QUESTION_TYPES, BANK_LOCALES } from '@/lib/bank/vocabulary'
import type { CommitResult } from '@/components/bank/import-panel'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The commit half of the importer.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THIS ACTION IS A HANDOFF, NOT A WRITER. IT INSERTS NOTHING ITSELF.        ║
 * ║                                                                           ║
 * ║ Every row goes to bank_import_commit() (0058) in ONE call, because one    ║
 * ║ function call is one transaction. Writing the rows from here instead      ║
 * ║ would be three statements per question, each its own transaction, and a   ║
 * ║ failure partway would leave questions that cannot be removed —            ║
 * ║ bank_questions has no DELETE policy by design.                            ║
 * ║                                                                           ║
 * ║ So the only jobs here are: check the caller, check the shape, hand it     ║
 * ║ over, and translate a database error into a sentence.                     ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * The dry run happens in the BROWSER (analyse.ts is pure), so what arrives here
 * is already-validated rows. That is a convenience, not a trust boundary: the
 * schema below re-validates independently, and the database re-checks the
 * permission, the brand and every constraint regardless of what this says.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * The row shape, re-stated as a schema rather than trusted from the client.
 *
 * Deliberately mirrors CommitRow in src/lib/bank/import/commit.ts. A client
 * could post anything at all to a Server Action, so "the browser already
 * checked it" is worth exactly nothing here.
 */
const commitText = z.object({
  locale: z.enum(BANK_LOCALES),
  question: z.string().min(1),
  optionA: z.string().nullable(),
  optionB: z.string().nullable(),
  optionC: z.string().nullable(),
  optionD: z.string().nullable(),
  answerText: z.string().nullable(),
  explanation: z.string().nullable(),
})

const commitRow = z.object({
  externalId: z.string().max(100).nullable(),
  difficulty: z.enum(DIFFICULTIES),
  qtype: z.enum(QUESTION_TYPES),
  status: z.enum(QUESTION_STATUSES),
  topicSlug: z.string().max(120).nullable(),
  correctOption: z.enum(['A', 'B', 'C', 'D']).nullable(),
  referenceTitle: z.string().max(300).nullable(),
  referencePage: z.number().int().min(1).max(10_000).nullable(),
  texts: z.array(commitText).min(1),
})

/**
 * Capped at the batch size the client uses.
 *
 * Not a guess: batchRows() splits at IMPORT_BATCH_SIZE, so a larger array can
 * only come from something that is not this screen. Refusing it keeps a single
 * request from growing into the statement timeout the batching exists to avoid.
 */
const commitInput = z.array(commitRow).min(1).max(IMPORT_BATCH_SIZE)

const DENIED = 'Questions are imported by Editors only.'

export async function commitImport(brandId: unknown, rows: unknown): Promise<CommitResult> {
  const claims = await getAppClaims()

  // The same two predicates the route layout and the nav use. A Super Admin
  // fails canOpenQuestionBank despite has_perm() returning true for them.
  if (!canOpenQuestionBank(claims) || !canEditQuestions(claims) || !claims.company_id) {
    return { ok: false, message: DENIED }
  }

  const brand = dbId().safeParse(brandId)
  if (!brand.success) return { ok: false, message: 'Choose a brand to import into.' }

  const parsed = commitInput.safeParse(rows)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return {
      ok: false,
      message: issue
        ? `A question in this batch is not shaped correctly (${issue.path.join('.') || 'root'}).`
        : 'This batch could not be read.',
    }
  }

  const supabase = await createClient()

  const { data, error } = await supabase.rpc('bank_import_commit', {
    p_brand_id: brand.data,
    p_rows: parsed.data,
  })

  if (error) return { ok: false, message: explain(error) }

  /*
   * gen-types.mjs emits `Returns: unknown` for every function, so the RPC
   * result is validated rather than asserted — the same treatment
   * bank_pool_counts gets in availability.ts. An unreadable result is reported
   * as a failure: the transaction may well have committed, and claiming a
   * specific number of imports we did not actually read would be worse than
   * saying it went wrong.
   */
  const result = z
    .object({ inserted: z.number().int(), updated: z.number().int() })
    .safeParse(data)

  if (!result.success) {
    return { ok: false, message: 'The import ran but its result could not be read.' }
  }

  revalidatePath('/questions')
  revalidatePath('/dashboard')
  revalidatePath('/papers/generate')

  return { ok: true, inserted: result.data.inserted, updated: result.data.updated }
}

/**
 * A database error, as a sentence somebody holding a 3,000-row file can act on.
 *
 * The whole batch rolled back, so every message says what to fix rather than
 * what was saved.
 */
function explain(error: { code?: string; message?: string }): string {
  switch (error.code) {
    case '23505':
      // bank_question_texts_dedupe_uq — the same English text, same brand, same
      // level. The dry run catches duplicates WITHIN a file; this is a clash
      // with a question already in the bank, including a deleted one.
      return 'This batch contains a question that is already in the bank for this brand and level. Check the recycle bin — a deleted question keeps its place.'
    case '23503':
      return error.message?.includes('topic')
        ? 'This batch names a topic that does not exist. Add it in Topic Management first.'
        : 'This batch refers to something that does not exist in this company.'
    case '23514':
      // The completeness trigger, or one of 0054's shape CHECKs.
      return 'A question in this batch could not be made active — usually a required translation is missing. Nothing was written.'
    case '42501':
      return DENIED
    default:
      return error.message
        ? `The import was rejected and nothing was written. ${error.message}`
        : 'The import was rejected and nothing was written.'
  }
}
