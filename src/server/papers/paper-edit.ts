import 'server-only'
import { createClient } from '@/lib/supabase/server'
import { getAppClaims } from '@/lib/auth/claims'
import { canGeneratePapers } from '@/lib/auth/bank-access'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Reads for the paper review-and-edit screen.
 *
 * Every one goes through a SECURITY DEFINER function added in 0072, not
 * through PostgREST, and that is deliberate on both counts:
 *
 *   · "eligible for this paper" needs a correlated NOT EXISTS against
 *     exam_paper_questions, which PostgREST cannot express. Filtering in
 *     JavaScript instead is how a picker ends up offering a question that is
 *     already question 4.
 *
 *   · exam_paper_content() — the function that feeds the printed paper —
 *     deliberately returns NO question id, and that omission is a security
 *     property of the printing path. Rather than weaken it, 0072 added a
 *     separate function for a separate caller, gated on papers.generate.
 *
 * None of these ever return an answer, a correct option or a model answer.
 * The screen exists to judge a paper, not to reveal it.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface PaperReviewQuestion {
  questionNo: number
  questionId: string
  section: 'mcq' | 'short_answer'
  topicId: string | null
  topicName: string | null
  question: string
  locales: string[]
}

export interface EligibleQuestion {
  questionId: string
  qtype: 'mcq' | 'short_answer'
  topicId: string | null
  topicName: string | null
  question: string
  locales: string[]
}

/** The paper's questions as they stand, with the ids the editor needs. */
export async function loadPaperReview(paperId: string): Promise<PaperReviewQuestion[]> {
  const claims = await getAppClaims()
  if (!canGeneratePapers(claims)) return []

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('paper_review_questions', { p_paper_id: paperId })

  // A refusal is not an empty paper. Returning [] for both would render "this
  // paper has no questions" to somebody who simply may not see it, which is a
  // more alarming and less true thing to say.
  if (error) throw new Error(`The paper could not be read: ${error.message}`)

  /*
   * Cast because gen-types.mjs emits `Returns: unknown` for every RPC — it
   * reads pg_proc, which does not describe a RETURNS TABLE shape in a form the
   * generator can turn into a type. Same convention as live.ts.
   */
  const rows = (data ?? []) as unknown as Array<{
    question_no: number
    question_id: string
    section: PaperReviewQuestion['section']
    topic_id: string | null
    topic_name: string | null
    question: string
    locales: string[] | null
  }>

  return rows.map((r) => ({
    questionNo: r.question_no,
    questionId: r.question_id,
    section: r.section,
    topicId: r.topic_id,
    topicName: r.topic_name,
    question: r.question,
    locales: r.locales ?? [],
  }))
}

/** Whether the paper may still be changed at all. */
export async function loadPaperEditable(paperId: string): Promise<boolean> {
  const claims = await getAppClaims()
  if (!canGeneratePapers(claims)) return false

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('paper_is_editable', { p_paper_id: paperId })
  if (error) return false
  return data === true
}

export interface EligibleFilters {
  topicId?: string | null
  qtype?: 'mcq' | 'short_answer' | null
  search?: string | null
  limit?: number
  offset?: number
}

/**
 * Candidates for a replacement.
 *
 * NOTE what is NOT a parameter: difficulty. A paper is one difficulty, fixed
 * at generation, and 0072 reads it from the paper rather than accepting it —
 * so the picker cannot be asked for a question the paper could not hold. The
 * product rule is that difficulty is never inferred and never varied within a
 * paper; making it a filter here would quietly contradict that.
 */
export async function loadEligibleQuestions(
  paperId: string,
  filters: EligibleFilters = {},
): Promise<EligibleQuestion[]> {
  const claims = await getAppClaims()
  if (!canGeneratePapers(claims)) return []

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('paper_eligible_questions', {
    p_paper_id: paperId,
    p_topic_id: filters.topicId ?? undefined,
    p_qtype: filters.qtype ?? undefined,
    p_search: filters.search ?? undefined,
    p_limit: filters.limit ?? 50,
    p_offset: filters.offset ?? 0,
  })

  if (error) throw new Error(`The question list could not be read: ${error.message}`)

  const rows = (data ?? []) as unknown as Array<{
    question_id: string
    qtype: EligibleQuestion['qtype']
    topic_id: string | null
    topic_name: string | null
    question: string
    locales: string[] | null
  }>

  return rows.map((r) => ({
    questionId: r.question_id,
    qtype: r.qtype,
    topicId: r.topic_id,
    topicName: r.topic_name,
    question: r.question,
    locales: r.locales ?? [],
  }))
}
