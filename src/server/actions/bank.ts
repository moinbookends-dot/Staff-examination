'use server'

import { revalidatePath } from 'next/cache'
import { getAppClaims } from '@/lib/auth/claims'
import { canEditQuestions, canOpenQuestionBank } from '@/lib/auth/bank-access'
import { createClient } from '@/lib/supabase/server'
import { dbId } from '@/lib/db/id'
import { BANK_LOCALES, type BankLocale } from '@/lib/bank/vocabulary'
import { makeQuestionInputSchema } from '@/lib/bank/schemas'
import type { BankMutationResult } from '@/lib/bank/types'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Question Bank mutations.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THREE GATES, AND NONE OF THEM IS THE NAVIGATION.                          ║
 * ║                                                                           ║
 * ║   1. canOpenQuestionBank / canEditQuestions here — the governance         ║
 * ║      boundary, which excludes super_admin even though has_perm() returns  ║
 * ║      true for them.                                                       ║
 * ║   2. RLS on bank_questions and bank_question_texts (0055) — the real one. ║
 * ║      Every write below goes through the caller's own client.              ║
 * ║   3. The database's own constraints — shape by type, the completeness     ║
 * ║      trigger, the duplicate index.                                        ║
 * ║                                                                           ║
 * ║ A server action is directly callable by anything that can reach the app;  ║
 * ║ hiding a route or a button protects nothing here.                         ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */

function denied(message: string): BankMutationResult {
  return { ok: false, reason: 'denied', message }
}

function failed(message: string): BankMutationResult {
  return { ok: false, reason: 'failed', message }
}

/**
 * The required languages for this company.
 *
 * Read per request rather than cached: it decides whether a question may be
 * published, and a stale value would either block a legitimate publish or
 * allow one the database then refuses.
 */
async function requiredLocales(
  supabase: Awaited<ReturnType<typeof createClient>>,
): Promise<BankLocale[]> {
  const { data } = await supabase.from('exam_settings').select('required_locales').maybeSingle()

  const raw = data?.required_locales ?? ['en']
  const valid = raw.filter((l): l is BankLocale =>
    (BANK_LOCALES as readonly string[]).includes(l),
  )
  // Never empty: an empty set would make every question trivially complete.
  return valid.length > 0 ? valid : ['en']
}

/** Rows for bank_question_texts, one per language actually written. */
function textRows(
  questionId: string,
  input: ReturnType<ReturnType<typeof makeQuestionInputSchema>['parse']>,
) {
  return BANK_LOCALES.flatMap((locale) => {
    const text = input.texts[locale]
    if (!text?.question) return []

    return [
      {
        question_id: questionId,
        // The composite FK in 0054 requires these to match the parent exactly.
        // Sent explicitly rather than relying on a default, because the FK is
        // what makes the duplicate index and the shape CHECK trustworthy.
        brand_id: input.brandId,
        difficulty: input.difficulty,
        qtype: input.qtype,
        locale,
        question: text.question,
        option_a: input.qtype === 'mcq' ? (text.optionA ?? null) : null,
        option_b: input.qtype === 'mcq' ? (text.optionB ?? null) : null,
        option_c: input.qtype === 'mcq' ? (text.optionC ?? null) : null,
        option_d: input.qtype === 'mcq' ? (text.optionD ?? null) : null,
        answer_text: input.qtype === 'short_answer' ? (text.answerText ?? null) : null,
      },
    ]
  })
}

/** Turn a Postgres error into something an Editor can act on. */
function describeWriteError(code: string | undefined, message: string): BankMutationResult {
  // 23505 on the dedupe index: this question already exists at this level.
  if (code === '23505') {
    return {
      ok: false,
      reason: 'duplicate',
      existingRowKey: null,
      message: 'That question is already in this bank at this level.',
    }
  }
  // The completeness trigger raises check_violation with a readable message,
  // so it is passed through rather than replaced with something vaguer.
  if (code === '23514' || code === 'P0001') {
    return { ok: false, reason: 'failed', message }
  }
  return failed('Could not save this question. Try again.')
}

export async function saveQuestion(raw: unknown): Promise<BankMutationResult> {
  const claims = await getAppClaims()

  if (!canOpenQuestionBank(claims) || !canEditQuestions(claims)) {
    return denied('The Question Bank is available to Editors only.')
  }
  if (!claims.userId || !claims.company_id) {
    return denied('Your account is not attached to a company.')
  }

  const supabase = await createClient()
  const required = await requiredLocales(supabase)

  // Built with the company's own required set, so the form's gate and the
  // database trigger agree about what "complete" means.
  const parsed = makeQuestionInputSchema(required).safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return failed(issue?.message ?? 'Check the question details.')
  }
  const input = parsed.data

  const existingId =
    raw && typeof raw === 'object' && 'id' in raw
      ? dbId().safeParse((raw as { id: unknown }).id)
      : null
  const isUpdate = Boolean(existingId?.success)

  /*
   * ┌─────────────────────────────────────────────────────────────────────────┐
   * │ THE PARENT GOES IN AS A DRAFT FIRST, ALWAYS.                            │
   * │                                                                         │
   * │ 0054's trigger refuses to make a question active while any required     │
   * │ language is missing — and on an INSERT the language rows do not exist   │
   * │ yet, so inserting directly as 'active' fails every time.                │
   * │                                                                         │
   * │ Parent as draft → texts → promote. The promote is a separate statement  │
   * │ the trigger can evaluate against rows that are actually there.          │
   * └─────────────────────────────────────────────────────────────────────────┘
   */
  let questionId: string

  if (isUpdate && existingId?.success) {
    questionId = existingId.data

    const { error } = await supabase
      .from('bank_questions')
      .update({
        brand_id: input.brandId,
        difficulty: input.difficulty,
        qtype: input.qtype,
        topic_id: input.topicId ?? null,
        correct_option: input.qtype === 'mcq' ? input.correctOption : null,
        reference_document_id: input.referenceDocumentId ?? null,
        reference_page: input.referencePage ?? null,
        // Held at draft until the texts are rewritten below.
        status: 'draft',
        updated_by: claims.userId,
      })
      .eq('id', questionId)

    if (error) return describeWriteError(error.code, error.message)
  } else {
    const { data, error } = await supabase
      .from('bank_questions')
      .insert({
        company_id: claims.company_id,
        brand_id: input.brandId,
        difficulty: input.difficulty,
        qtype: input.qtype,
        topic_id: input.topicId ?? null,
        correct_option: input.qtype === 'mcq' ? input.correctOption : null,
        reference_document_id: input.referenceDocumentId ?? null,
        reference_page: input.referencePage ?? null,
        status: 'draft',
        // bank_questions_insert requires created_by = auth.uid(), so a question
        // cannot be attributed to somebody who did not write it.
        created_by: claims.userId,
      })
      .select('id')
      .single()

    if (error || !data) return describeWriteError(error?.code, error?.message ?? '')
    questionId = data.id
  }

  /*
   * ╔═══════════════════════════════════════════════════════════════════════════╗
   * ║ WRITE THE NEW TEXTS FIRST, REMOVE THE OLD ONES AFTER. NEVER THE REVERSE.  ║
   * ║                                                                           ║
   * ║ This used to DELETE every text row and then INSERT the replacements.      ║
   * ║ Each statement is its own transaction over PostgREST, so a failure on the ║
   * ║ insert left the question with NO TEXT AT ALL — permanently, because there ║
   * ║ is no revision history to recover it from. Demonstrated against the real  ║
   * ║ database during the stabilization audit:                                  ║
   * ║                                                                           ║
   * ║     BEFORE  status=active texts=1                                         ║
   * ║     step 1  UPDATE status=draft   204                                     ║
   * ║     step 2  DELETE texts          204                                     ║
   * ║     step 3  INSERT texts          409 23505   ← duplicate English text    ║
   * ║     AFTER   status=draft texts=0              ← the question is empty     ║
   * ║                                                                           ║
   * ║ The trigger is ordinary: rename a question to text another question at    ║
   * ║ the same brand and level already uses, and the dedupe index refuses the   ║
   * ║ insert. The Editor is told "already in the bank", assumes nothing         ║
   * ║ happened, and the question they were editing has been emptied.            ║
   * ║                                                                           ║
   * ║ Upserting first means a refused write changes nothing: the old rows are   ║
   * ║ still there and the question is intact. Only once the new text is safely  ║
   * ║ stored are the languages the Editor removed deleted.                      ║
   * ║                                                                           ║
   * ║ bank_import_commit() (0058) does exactly this, inside one transaction.    ║
   * ║ It cannot be reused here: it matches on external_id, and a question typed ║
   * ║ into this form has none.                                                  ║
   * ╚═══════════════════════════════════════════════════════════════════════════╝
   */
  const rows = textRows(questionId, input)

  if (rows.length > 0) {
    // onConflict is the composite primary key (question_id, locale), so an
    // existing language is overwritten in place rather than colliding.
    const { error } = await supabase
      .from('bank_question_texts')
      .upsert(rows, { onConflict: 'question_id,locale' })

    if (error) return describeWriteError(error.code, error.message)
  }

  /*
   * A language the Editor removed from the form has to disappear, or it would
   * still be printed on a paper nobody expects it on.
   *
   * Safe here for two reasons: the new text is already committed, and the
   * parent is still a draft — bank_question_texts_completeness_guard only
   * refuses a delete that would leave an ACTIVE question short of a required
   * language, and the promote below has not run yet.
   */
  const keptLocales = rows.map((row) => row.locale)

  if (keptLocales.length > 0) {
    const { error } = await supabase
      .from('bank_question_texts')
      .delete()
      .eq('question_id', questionId)
      .not('locale', 'in', `(${keptLocales.join(',')})`)

    if (error) return describeWriteError(error.code, error.message)
  }

  // Now that the languages exist, ask for the status the Editor wanted. The
  // trigger has something real to check.
  if (input.status !== 'draft') {
    const { error } = await supabase
      .from('bank_questions')
      .update({ status: input.status })
      .eq('id', questionId)

    if (error) return describeWriteError(error.code, error.message)
  }

  revalidatePath('/questions')
  return { ok: true, id: questionId, rowKey: questionId }
}

/**
 * Archive, restore, or soft-delete.
 *
 * One action for three transitions because they are one UPDATE with a
 * different payload; splitting them would be three copies of the same guard.
 */
export async function setQuestionState(
  id: unknown,
  state: 'active' | 'draft' | 'archived' | 'deleted' | 'restored',
): Promise<BankMutationResult> {
  const claims = await getAppClaims()
  if (!canOpenQuestionBank(claims) || !canEditQuestions(claims)) {
    return denied('The Question Bank is available to Editors only.')
  }

  const parsed = dbId().safeParse(id)
  if (!parsed.success) return failed('That question could not be found.')

  const supabase = await createClient()

  const patch =
    state === 'deleted'
      ? { deleted_at: new Date().toISOString() }
      : state === 'restored'
        ? { deleted_at: null }
        : { status: state }

  /*
   * Counted, not merely error-checked.
   *
   * RLS REFUSES BY FILTERING: an update the policies do not admit returns
   * error null having changed nothing. deleteQuestion and deleteExam were both
   * bitten by exactly this and reported success for rows they never touched.
   */
  const { error, count } = await supabase
    .from('bank_questions')
    .update({ ...patch, updated_by: claims.userId }, { count: 'exact' })
    .eq('id', parsed.data)

  if (error) return describeWriteError(error.code, error.message)
  if (count !== 1) return denied('That question could not be changed.')

  revalidatePath('/questions')
  return { ok: true, id: parsed.data, rowKey: parsed.data }
}
