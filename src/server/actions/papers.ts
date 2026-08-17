'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { getAppClaims, can } from '@/lib/auth/claims'
import { loadEligibleQuestions, type EligibleQuestion } from '@/server/papers/paper-edit'
import { canGeneratePapers } from '@/lib/auth/bank-access'
import { createClient } from '@/lib/supabase/server'
import { dbId } from '@/lib/db/id'
import { DIFFICULTIES } from '@/lib/bank/vocabulary'
import { PAPER_SIZES } from '@/lib/papers/blueprint'
import { generatePaper as runGenerator } from '@/lib/papers/generate'
import { createPaperRepository } from '@/server/papers/repository'
// The audience is chosen while publishing now; reuse the exam layer's own
// schema and writer rather than restating the target-shape CHECK here.
import { setAssignments } from '@/server/actions/exams'
import { assignmentSchema } from '@/lib/exams/rules'
import type { GenerateOutcome } from '@/components/papers/generate-panel'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Generate a paper.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THIS ACTION DECIDES NOTHING ABOUT HOW A PAPER IS BUILT.                   ║
 * ║                                                                           ║
 * ║ The draw, the 80/20 blueprint, the never-twice rule, the exhaustion       ║
 * ║ arithmetic and the retry loop all live in src/lib/papers/generate.ts,     ║
 * ║ which is unit-tested against a fake repository. Re-deriving any of it     ║
 * ║ here would create a second implementation that the tests do not cover —   ║
 * ║ and the two would drift.                                                  ║
 * ║                                                                           ║
 * ║ So this file does four things and stops: check the caller, resolve the    ║
 * ║ brand, run the generator, and translate its result into the union the     ║
 * ║ panel renders.                                                            ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Passing this as `onGenerate` is what enables the button: GeneratePanel gates
 * on the prop being present rather than on a separate "is it wired" flag, so
 * until this existed the control was disabled by construction.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const generateInput = z.object({
  difficulty: z.enum(DIFFICULTIES),
  /*
   * Only the sizes the product offers. blueprintFor() would throw on anything
   * that cannot split 80/20 into whole questions, and a thrown error inside a
   * Server Action has no boundary to catch it.
   *
   * WRITTEN AGAINST THE ARRAY'S LENGTH, NOT AGAINST TWO FIXED ENTRIES. This
   * was `z.union([z.literal(PAPER_SIZES[0]), z.literal(PAPER_SIZES[1])])`,
   * which stopped compiling the moment the 50-mark size was retired and
   * PAPER_SIZES became a one-element tuple — z.union also requires at least
   * two members, so it could never have expressed a single size. A refinement
   * over the array is correct for one size or ten.
   */
  marks: z.number().refine(
    (n): n is (typeof PAPER_SIZES)[number] => (PAPER_SIZES as readonly number[]).includes(n),
    { message: 'That paper size is not offered.' },
  ),
  brandId: dbId().optional(),
})

const DENIED = 'You are not permitted to generate papers.'

export async function generatePaper(raw: unknown): Promise<GenerateOutcome> {
  const claims = await getAppClaims()

  if (!canGeneratePapers(claims) || !claims.userId || !claims.company_id) {
    return { status: 'failed', message: DENIED }
  }

  const parsed = generateInput.safeParse(raw)
  if (!parsed.success) {
    return { status: 'failed', message: 'Choose a level and a paper size.' }
  }
  const input = parsed.data

  /*
   * ┌─────────────────────────────────────────────────────────────────────────┐
   * │ THE PINNED BRAND WINS OVER ANYTHING THE CLIENT SENT.                    │
   * │                                                                         │
   * │ Same precedence as /api/bank/export: `claims.brand_id ?? requested`. A  │
   * │ Chef pinned to one brand cannot widen their scope by editing the        │
   * │ payload, because their own claim is consulted first and the request's   │
   * │ value is never reached.                                                 │
   * │                                                                         │
   * │ 0059's functions re-check this too — brand_in_my_company() — so a       │
   * │ forged brand fails at the database as well. This is the readable copy.  │
   * └─────────────────────────────────────────────────────────────────────────┘
   */
  const brandId = claims.brand_id ?? input.brandId
  if (!brandId) {
    return { status: 'failed', message: 'Choose a brand to generate from.' }
  }

  // RLS makes another company's brand simply absent, so "not found" and "not
  // yours" are the same answer.
  const supabase = await createClient()
  const { data: brand } = await supabase
    .from('brands')
    .select('id')
    .eq('id', brandId)
    .is('deleted_at', null)
    .maybeSingle()

  if (!brand) return { status: 'failed', message: DENIED }

  const scope = {
    companyId: claims.company_id,
    brandId,
    difficulty: input.difficulty,
    marks: input.marks,
  }

  let result
  try {
    result = await runGenerator(
      { scope, generatedBy: claims.userId },
      createPaperRepository(scope),
    )
  } catch (err) {
    /*
     * The repository throws for a refused permission, an unknown brand, or a
     * question that stopped being active mid-draw. Reported as a failed
     * outcome rather than allowed to escape: an unhandled throw in a Server
     * Action reaches the client as an opaque digest with no message at all.
     */
    return {
      status: 'failed',
      message: err instanceof Error ? err.message : 'The paper could not be generated.',
    }
  }

  switch (result.status) {
    case 'generated':
      // The paper now exists in history and changes the dashboard counts.
      revalidatePath('/history')
      revalidatePath('/dashboard')
      revalidatePath('/papers/generate')

      return {
        status: 'generated',
        paperId: result.paperId,
        paperNo: result.paperNo,
        totalCombinations: result.totalCombinations,
        unlimited: result.unlimited,
      }

    case 'short':
      // `marks` rather than the whole blueprint: the panel prints "needs 16,
      // has 9" per type and derives nothing else from it.
      return { status: 'short', shortfalls: result.shortfalls, marks: result.blueprint.marks }

    case 'exhausted':
      return { status: 'exhausted' }

    default:
      return { status: 'failed', message: result.message }
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Move a paper between generated → live → retired.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THIS LABELS THE PAPER. IT DOES NOT OPEN AN EXAM.                          │
 * │                                                                           │
 * │ This comment used to say the label had nothing to do with online          │
 * │ delivery, because at the time there was none. 0062 changed that: `live`   │
 * │ now means "in use" whether the paper is printed, sat on a screen, or       │
 * │ both, and publishPaperAsExam() below sets it as a side effect.            │
 * │                                                                           │
 * │ What is still true is the direction: setting a paper live here does NOT   │
 * │ create an exam, assign anybody, or let a single candidate answer          │
 * │ anything. A Chef marking this week's printed paper is doing exactly what  │
 * │ they always were.                                                         │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
const statusInput = z.object({
  paperId: dbId(),
  // 'generated' is deliberately absent: 0061 refuses a return to the state a
  // paper is born in, and offering it here would be a button that always fails.
  status: z.enum(['live', 'retired']),
})

export type PaperStatusResult =
  | { ok: true; status: 'live' | 'retired'; paperNo: number }
  | { ok: false; message: string }

export async function setPaperStatus(raw: unknown): Promise<PaperStatusResult> {
  const claims = await getAppClaims()

  if (!canGeneratePapers(claims) || !claims.company_id) {
    return { ok: false, message: 'You are not permitted to change a paper.' }
  }

  const parsed = statusInput.safeParse(raw)
  if (!parsed.success) return { ok: false, message: 'That paper could not be found.' }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('set_paper_status', {
    p_paper_id: parsed.data.paperId,
    p_status: parsed.data.status,
  })

  if (error) {
    // 0061 raises no_data_found for a paper the caller cannot see — the same
    // answer as "does not exist", deliberately.
    return {
      ok: false,
      message:
        error.code === 'P0002'
          ? 'That paper could not be found.'
          : `The paper could not be updated. ${error.message}`,
    }
  }

  const result = z
    .object({ status: z.enum(['live', 'retired']), paperNo: z.number().int() })
    .safeParse(data)

  if (!result.success) {
    return { ok: false, message: 'The paper was updated but its new state could not be read.' }
  }

  revalidatePath('/history')
  revalidatePath(`/history/${parsed.data.paperId}`)

  return { ok: true, status: result.data.status, paperNo: result.data.paperNo }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Publish a generated paper as an online exam.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE PAPER IS NOT COPIED, MODIFIED, OR CONSUMED.                           ║
 * ║                                                                           ║
 * ║ 0063 writes one row — an `exams` row carrying paper_id. exam_papers and   ║
 * ║ exam_paper_questions are never written by this path (except the paper's   ║
 * ║ own generated → live label), so the printed PDF and the on-screen exam    ║
 * ║ are guaranteed to be the same twenty questions in the same order: they    ║
 * ║ are read from the same rows.                                              ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ NO AUDIENCE IS SET HERE, AND THAT IS THE SAFE DIRECTION TO FAIL.          │
 * │                                                                           │
 * │ Assignment is a separate, existing surface — ExamAssignments on           │
 * │ /exams/[id], writing exam_assignments under its own RLS. Duplicating the  │
 * │ picker into the publish form would put a second implementation of "who    │
 * │ sits this" in the codebase.                                               │
 * │                                                                           │
 * │ Until somebody is assigned, is_exam_assigned_to_me() answers false for    │
 * │ every candidate and start_attempt refuses. A half-finished publish is     │
 * │ therefore an exam nobody can see, rather than an exam everybody can.      │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
const publishInput = z.object({
  paperId: dbId(),
  title: z.string().trim().min(1).max(200),
  // Bounded here as well as in the form. A Server Action is a public endpoint
  // and the form's `min`/`max` attributes are a courtesy to the person typing,
  // not a constraint on what arrives.
  durationMinutes: z.coerce.number().int().min(5).max(480),
  maxAttempts: z.coerce.number().int().min(1).max(10),
  passMarkPercent: z.coerce.number().int().min(1).max(100),
  opensAt: z.string().datetime({ offset: true }).nullable().optional(),
  /*
   * REQUIRED, unlike the legacy exam model. 0064 refuses a paper-backed exam
   * without a deadline: without one the exam never reaches `closed`, and an
   * on_close release would never fire.
   */
  closesAt: z.string().datetime({ offset: true }),
  instructions: z.string().trim().max(2000).optional(),
  resultsRelease: z.enum(['immediate', 'on_close']).default('immediate'),
  /*
   * ┌───────────────────────────────────────────────────────────────────────────┐
   * │ THE AUDIENCE IS PART OF PUBLISHING NOW.                                  │
   * │                                                                           │
   * │ It used to be a separate visit to /exams/[id], and the gap between the    │
   * │ two steps was a real failure mode: publishing succeeded, nobody was       │
   * │ assigned, and the exam reached nobody. The paper page still carries the   │
   * │ "nobody has been chosen yet" warning for anyone who skips this.           │
   * │                                                                           │
   * │ Reuses exams.ts's assignmentSchema rather than restating the target       │
   * │ shape — the four target columns have a CHECK constraint behind them and   │
   * │ a second copy of that rule would drift.                                   │
   * └───────────────────────────────────────────────────────────────────────────┘
   */
  assignments: z.array(assignmentSchema).max(100).default([]),
})

export type PublishPaperResult =
  | {
      ok: true
      examId: string
      paperNo: number
      /**
       * Set when the exam published but its audience did not save. The publish
       * itself succeeded, so this is a warning to carry to the reader rather
       * than a failure — see the box in publishPaperAsExam.
       */
      assignmentError?: string
    }
  | { ok: false; message: string }

export async function publishPaperAsExam(raw: unknown): Promise<PublishPaperResult> {
  /*
   * Both permissions, matching 0063 exactly. exams.create alone would let
   * somebody who may draft an exam put one live without exams.publish, which is
   * the separation publish_exam() has always enforced for the legacy path.
   */
  const claims = await getAppClaims()
  if (!can(claims, 'exams.create') || !can(claims, 'exams.publish')) {
    return { ok: false, message: 'You are not permitted to publish an exam.' }
  }

  const parsed = publishInput.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, message: parsed.error.issues[0]?.message ?? 'Check the details and try again.' }
  }
  const input = parsed.data

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('publish_paper_as_exam', {
    p_paper_id: input.paperId,
    p_title: input.title,
    p_duration_minutes: input.durationMinutes,
    p_opens_at: input.opensAt ?? null,
    p_closes_at: input.closesAt,
    p_max_attempts: input.maxAttempts,
    p_pass_mark_percent: input.passMarkPercent,
    p_instructions: input.instructions || null,
    p_results_release: input.resultsRelease,
  })

  if (error) {
    /*
     * 0063's errcodes, mapped to sentences. The unique_violation case is worth
     * its own message because it is the one a Chef will actually hit — the
     * paper is already open as an exam and they are looking at the wrong screen.
     */
    const message =
      error.code === 'P0002'
        ? 'That paper could not be found.'
        : error.code === '23505'
          ? 'That paper is already published as an open exam.'
          : error.code === '23514'
            ? error.message
            : `The exam could not be published. ${error.message}`

    return { ok: false, message }
  }

  const result = z
    .object({ examId: dbId(), paperNo: z.number().int() })
    .safeParse(data)

  if (!result.success) {
    return { ok: false, message: 'The exam was created but could not be read back.' }
  }

  /*
   * ┌───────────────────────────────────────────────────────────────────────────┐
   * │ THE AUDIENCE IS SET SECOND, AND A FAILURE HERE IS NOT FATAL.              │
   * │                                                                           │
   * │ The exam already exists by this point, so throwing away a successful      │
   * │ publish because the assignment write failed would be the worse outcome —  │
   * │ the paper would be marked live with an exam the caller never learns the   │
   * │ id of, and 0062's index would then refuse a second attempt.               │
   * │                                                                           │
   * │ An exam with no audience is invisible rather than open to everyone, and   │
   * │ the paper page states that plainly, so the safe failure is to report the  │
   * │ exam as published and let the reader fix the audience there.              │
   * │                                                                           │
   * │ setAssignments carries its own exams.assign guard — this does not widen   │
   * │ who may choose an audience, it only moves when they do it.                │
   * └───────────────────────────────────────────────────────────────────────────┘
   */
  let assignmentError: string | undefined
  if (input.assignments.length > 0) {
    const assigned = await setAssignments({
      examId: result.data.examId,
      assignments: input.assignments,
    })
    if (!assigned.ok) assignmentError = assigned.error
  }

  revalidatePath('/history')
  revalidatePath(`/history/${input.paperId}`)
  revalidatePath('/exams/live')

  return {
    ok: true,
    examId: result.data.examId,
    paperNo: result.data.paperNo,
    assignmentError,
  }
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Saving an edited paper, and finding a question to put on it.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ ONE SAVE, NOT ONE REQUEST PER CHANGE.                                     ║
 * ║                                                                           ║
 * ║ Removing, replacing and reordering all happen in the browser as local     ║
 * ║ state. Nothing reaches the database until Save is pressed, and then the   ║
 * ║ WHOLE list goes at once.                                                  ║
 * ║                                                                           ║
 * ║ That is not only about latency, though a round trip to this project costs ║
 * ║ a measured ~120ms and nobody should pay it to nudge question 7 up one     ║
 * ║ place. It is about validity: the invariants are properties of the whole   ║
 * ║ paper — the MCQ/short split, the total, no duplicates — and a paper that  ║
 * ║ is briefly 19 questions long between two requests is a paper that could   ║
 * ║ be published in that state if the second request never arrives.           ║
 * ║                                                                           ║
 * ║ NO OPTIMISTIC UPDATE ON THE SAVE ITSELF. The local list can move freely;  ║
 * ║ whether the SAVE succeeded is answered by the server and nothing else. An ║
 * ║ optimistic "saved!" that later turned out to be a duplicate paper or an   ║
 * ║ ineligible question would be a lie about an exam.                         ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */
const editInput = z.object({
  paperId: dbId(),
  questions: z
    .array(
      z.object({
        questionId: dbId(),
        questionNo: z.number().int().min(1).max(200),
        section: z.enum(['mcq', 'short_answer']),
      }),
    )
    // Bounded so a malformed client cannot post a million rows at the RPC. The
    // real composition rules are the database's — this only stops nonsense
    // arriving.
    .min(1)
    .max(200),
})

export type SavePaperResult =
  | { ok: true; paperNo: number; questions: number }
  | { ok: false; message: string }

export async function savePaperQuestions(raw: unknown): Promise<SavePaperResult> {
  const claims = await getAppClaims()

  if (!canGeneratePapers(claims) || !claims.company_id) {
    return { ok: false, message: 'You are not permitted to edit a paper.' }
  }

  const parsed = editInput.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, message: 'That paper could not be saved. Reload and try again.' }
  }

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('edit_paper_questions', {
    p_paper_id: parsed.data.paperId,
    p_questions: parsed.data.questions,
  })

  if (error) {
    /*
     * 0072's messages are written for this screen and are surfaced verbatim —
     * "Paper 8 needs 16 MCQ and 4 short answers; got 15 and 5" tells somebody
     * exactly what to do, and a generic "could not be saved" does not.
     *
     * The exception is no_data_found, which covers both "no such paper" and
     * "not yours". Those must stay indistinguishable.
     */
    if (error.code === 'P0002') return { ok: false, message: 'That paper could not be found.' }
    return { ok: false, message: error.message }
  }

  const result = z
    .object({ paperNo: z.number().int(), questions: z.number().int() })
    .safeParse(data)

  if (!result.success) {
    return { ok: false, message: 'The paper was saved but its new state could not be read.' }
  }

  revalidatePath('/history')
  revalidatePath(`/history/${parsed.data.paperId}`)

  return { ok: true, paperNo: result.data.paperNo, questions: result.data.questions }
}

const eligibleInput = z.object({
  paperId: dbId(),
  topicId: dbId().nullable().optional(),
  qtype: z.enum(['mcq', 'short_answer']).nullable().optional(),
  search: z.string().trim().max(200).nullable().optional(),
})

export type EligibleResult =
  | { ok: true; questions: EligibleQuestion[] }
  | { ok: false; message: string }

/**
 * Candidates for a replacement.
 *
 * DIFFICULTY IS NOT A FILTER, here or in the RPC. A paper is one difficulty,
 * fixed when it was generated, and the product rule is that difficulty is
 * never inferred. Offering it as a control would imply a paper can mix levels.
 */
export async function findEligibleQuestions(raw: unknown): Promise<EligibleResult> {
  const claims = await getAppClaims()
  if (!canGeneratePapers(claims)) {
    return { ok: false, message: 'You are not permitted to edit a paper.' }
  }

  const parsed = eligibleInput.safeParse(raw)
  if (!parsed.success) return { ok: false, message: 'Those filters could not be read.' }

  try {
    const questions = await loadEligibleQuestions(parsed.data.paperId, {
      topicId: parsed.data.topicId ?? null,
      qtype: parsed.data.qtype ?? null,
      search: parsed.data.search ?? null,
    })
    return { ok: true, questions }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : 'The bank could not be read.' }
  }
}
