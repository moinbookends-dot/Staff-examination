'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import type { SupabaseClient } from '@supabase/supabase-js'
import { requirePermission } from '@/lib/auth/guards'
import { createClient } from '@/lib/supabase/server'
import type { Database } from '@/lib/db/database.types'
import { dbId } from '@/lib/db/id'
import {
  CANCELLABLE_STATUSES,
  JOB_STATUSES,
  emptyJobCounts,
  inFlightJobs,
  unaccountedJobs,
  type JobProgress,
} from '@/lib/jobs/types'
import type { MutationResult } from './questions'

/**
 * The job queue's read and write paths (0051).
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE USER'S CLIENT, AND ONLY THE USER'S CLIENT.                            │
 * │                                                                           │
 * │ 0051 is SECURITY INVOKER end to end — no definer functions, no service    │
 * │ role, not even for claiming — so createClient() is the entire             │
 * │ authorisation story here. jobs_read scopes every count below to           │
 * │ my_company(); jobs_update scopes every write. This file re-implements     │
 * │ neither, and there is no admin client to reach for if one of them refuses.│
 * │                                                                           │
 * │ requirePermission is therefore doing one job: keeping somebody with no    │
 * │ claim on the bank out of the table before a query is spent. It keys on    │
 * │ the same permissions the policies do — questions.read for the progress    │
 * │ count, questions.import for both writes — so a caller who slipped past    │
 * │ these lines would still touch nothing.                                    │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * WHAT IS NOT HERE, AND WHY. The worker. claim_job(), the blocking update and
 * the stale-lock reaper are all written out in 0051 and none of them belongs in
 * a server action: a claim runs in a loop in a process that outlives a request,
 * and `for update skip locked` inside a Next.js action would take a row lock
 * held for exactly as long as an HTTP handler. It arrives whole, in the next
 * slice, and 0051's claim box is the specification for it.
 *
 * Enqueueing is not here either. A job is created by whatever creates the work
 * — the upload path that splits a PDF into document_pages, the batch that
 * finishes OCR and queues extraction — and an enqueue action with no producer
 * behind it would be a button that makes rows nothing will ever read.
 */

// ─────────────────────────────────────────────────────────────────────────────
// The generated-types shim
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ A TOMBSTONE WITH A COMPILE ERROR ATTACHED TO IT.                          │
 * │                                                                           │
 * │ database.types.ts is generated from the LIVE schema and says so at the    │
 * │ top: "Regenerate after every migration." 0051 is written and not applied, │
 * │ so `jobs` is not in it and supabase-js — which resolves .from() against   │
 * │ keyof Tables — cannot type a query against a table the file has never     │
 * │ heard of.                                                                 │
 * │                                                                           │
 * │ The two obvious ways out are both bad. Writing .from('jobs') against the  │
 * │ real client leaves the repo not compiling until a migration is applied.   │
 * │ Casting to an untyped SupabaseClient compiles and silently gives up every │
 * │ column name in this file, which is how `status: 'cancelled'` becomes      │
 * │ `state: 'cancelled'` and nobody finds out until a chef presses cancel.    │
 * │                                                                           │
 * │ So the table is declared here exactly as the generator will declare it —  │
 * │ `kind` and `status` as plain `string`, because the generator reads        │
 * │ columns and not CHECK constraints — and the assertion below stops         │
 * │ compiling the moment the real thing arrives. Deleting this block then is  │
 * │ a no-op for every line beneath it, which is the property that makes it    │
 * │ safe to delete without reading the rest of the file.                      │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
type JobsTable = {
  Row: {
    id: string
    company_id: string
    kind: string
    payload: unknown
    status: string
    attempts: number
    max_attempts: number
    run_after: string
    locked_at: string | null
    locked_by: string | null
    last_error: string | null
    source_document_id: string | null
    import_batch_id: string | null
    document_page_id: string | null
    created_by: string
    created_at: string
    updated_at: string
  }
  Insert: {
    id?: string
    company_id: string
    kind: string
    payload: unknown
    status?: string
    attempts?: number
    max_attempts?: number
    run_after?: string
    locked_at?: string | null
    locked_by?: string | null
    last_error?: string | null
    source_document_id?: string | null
    import_batch_id?: string | null
    document_page_id?: string | null
    created_by: string
    created_at?: string
    updated_at?: string
  }
  Update: {
    id?: string
    company_id?: string
    kind?: string
    payload?: unknown
    status?: string
    attempts?: number
    max_attempts?: number
    run_after?: string
    locked_at?: string | null
    locked_by?: string | null
    last_error?: string | null
    source_document_id?: string | null
    import_batch_id?: string | null
    document_page_id?: string | null
    created_by?: string
    created_at?: string
    updated_at?: string
  }
  Relationships: []
}

type DatabaseWithJobs = {
  public: Omit<Database['public'], 'Tables'> & {
    Tables: Database['public']['Tables'] & { jobs: JobsTable }
  }
}

/**
 * Fails to compile once `npm run gen:types` has run against an applied 0051.
 * That failure is the instruction: delete JobsTable, DatabaseWithJobs, jobsDb
 * and this type, and let `await createClient()` be used directly below.
 */
type AssertJobsNotGenerated<T extends false> = T
export type JobsShimStillNeeded = AssertJobsNotGenerated<
  'jobs' extends keyof Database['public']['Tables'] ? true : false
>

/** The one cast in this file, in one place, with the assertion above guarding it. */
function jobsDb(
  client: Awaited<ReturnType<typeof createClient>>,
): SupabaseClient<DatabaseWithJobs> {
  return client as unknown as SupabaseClient<DatabaseWithJobs>
}

// ─────────────────────────────────────────────────────────────────────────────

const documentSchema = z.object({ documentId: dbId() })

/**
 * Progress for one document: how many of its jobs are in each status.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ SEVEN COUNTS, NOT ONE FETCH OF EVERY ROW.                                 │
 * │                                                                           │
 * │ PostgREST has no GROUP BY, so the tempting shape is                       │
 * │ `.select('status').eq('source_document_id', id)` and a tally in           │
 * │ JavaScript. That transfers a row per job to produce six integers, and —   │
 * │ the part that actually bites — PostgREST caps rows returned. A 113-page   │
 * │ cookbook is fine; the document that is not fine comes back TRUNCATED,     │
 * │ with no error, and the tally is simply wrong. Wrong in the direction that │
 * │ makes a bar look finished, which is the exact failure 0051 refused a      │
 * │ second progress table in order to avoid.                                  │
 * │                                                                           │
 * │ `head: true, count: 'exact'` sends no rows at all and returns a number    │
 * │ the database counted. Six of them plus a total is seven index-only scans  │
 * │ of jobs_document_progress_idx, which 0051 built as                        │
 * │ (source_document_id, status) for precisely this query.                    │
 * │                                                                           │
 * │ The statuses come from JOB_STATUSES rather than a list written here, so   │
 * │ a status added to the vocabulary is counted without anybody remembering   │
 * │ to add it — and one added to the CHECK but NOT to the vocabulary shows up │
 * │ as `unaccounted`, which is why total is read separately instead of summed.│
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * DEGRADES TO null, NOT TO ZEROS — a deliberate departure from
 * listSourceDocuments, which returns an empty shelf when its read fails. An
 * empty shelf reads as "nothing here yet", which is honest. A progress object
 * full of zeros reads as "nothing left to do", which is a lie, and it is told
 * at the one moment somebody is watching to find out whether they can leave.
 * null lets the caller render "progress unavailable" instead.
 */
export async function listJobs(input: unknown): Promise<JobProgress | null> {
  await requirePermission('questions.read')

  // Re-parsed here rather than trusted, as listSourceDocuments and
  // listQuestions do: this is a server action and its argument is whatever a
  // client sent. There is no partial recovery to attempt — a progress bar for
  // an unparseable document id is not a narrower question, it is no question.
  const parsed = documentSchema.safeParse(input)
  if (!parsed.success) return null
  const { documentId } = parsed.data

  const supabase = jobsDb(await createClient())

  // NO .eq('company_id', …). jobs_read scopes this to my_company(), and a
  // second copy of that rule here could only ever disagree with the first.
  const totalQuery = supabase
    .from('jobs')
    .select('id', { count: 'exact', head: true })
    .eq('source_document_id', documentId)

  const statusQueries = JOB_STATUSES.map((status) =>
    supabase
      .from('jobs')
      .select('id', { count: 'exact', head: true })
      .eq('source_document_id', documentId)
      .eq('status', status),
  )

  const [totalResult, ...statusResults] = await Promise.all([totalQuery, ...statusQueries])

  if (totalResult.error) return null

  const byStatus = emptyJobCounts()
  for (let i = 0; i < JOB_STATUSES.length; i++) {
    const result = statusResults[i]
    // One failed count is not a smaller answer, it is a wrong one: the bar
    // would render that status as zero and the document as further along than
    // it is. All seven or none.
    if (!result || result.error) return null
    byStatus[JOB_STATUSES[i]] = result.count ?? 0
  }

  const total = totalResult.count ?? 0

  return {
    documentId,
    total,
    byStatus,
    inFlight: inFlightJobs(byStatus),
    unaccounted: unaccountedJobs(total, byStatus),
  }
}

/**
 * Withdraw a job that has not started.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE COUNT IS THE POINT, FOR THE THIRD TIME IN THIS CODEBASE.              │
 * │                                                                           │
 * │ RLS refuses by FILTERING, not by erroring. An UPDATE that matches no row  │
 * │ because jobs_update excluded it returns `error: null` and changes         │
 * │ nothing, so an action that checks only `error` reports success for a job  │
 * │ it never touched.                                                         │
 * │                                                                           │
 * │ deleteQuestion shipped with exactly that defect (3b52dcc) and told chefs  │
 * │ "Question removed" over a row that was still there. deleteExam had it     │
 * │ again in 0049. It is the same shape here and it is worse: a cancel that   │
 * │ reports success and does not cancel leaves somebody watching a queue      │
 * │ drain that they believe they stopped, and paying a provider for it.       │
 * │                                                                           │
 * │ 0051 makes the same argument about claim_job's has_perm raise — that a    │
 * │ refusal and an idle queue must not produce the same empty answer.         │
 * │                                                                           │
 * │ And here the count is the ONLY thing that can catch it. deleteExam at     │
 * │ least raised outright until 0049, because every select policy on `exams`  │
 * │ carried `deleted_at is null` and the archiving update moved the row       │
 * │ outside all of them. public.jobs has no deleted_at and no select policy   │
 * │ with a predicate this update can violate — 0051 says so in as many words  │
 * │ — so there is no loud failure waiting in reserve behind a missing check.  │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * The `.in()` on CANCELLABLE_STATUSES is the second half of the check: it is
 * what makes a zero count mean "not yours, or already finished" rather than
 * "cancelled a job that was three quarters of the way through a provider call".
 * See CANCELLABLE_STATUSES for why 'running' is not in that list.
 */
export async function cancelJob(id: string): Promise<MutationResult> {
  await requirePermission('questions.import')

  const parsed = dbId().safeParse(id)
  if (!parsed.success) return { ok: false, error: 'Invalid job.' }

  const supabase = jobsDb(await createClient())
  const { error, count } = await supabase
    .from('jobs')
    .update({ status: 'cancelled' }, { count: 'exact' })
    .eq('id', parsed.data)
    // Spread because CANCELLABLE_STATUSES is `as const` and .in() takes a
    // mutable array — the same reason listSourceDocuments spreads KIND_GROUPS.
    .in('status', [...CANCELLABLE_STATUSES])

  if (error) return { ok: false, error: 'Could not cancel this job.' }
  if (count === 0) return { ok: false, error: 'That job could not be cancelled.' }

  revalidatePath('/guide')
  return { ok: true }
}

/**
 * Re-queue the pages of one document that failed, and nothing else.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WITHOUT `attempts: 0` THIS FUNCTION DOES NOTHING, SUCCESSFULLY.           │
 * │                                                                           │
 * │ claim_job filters on `attempts < max_attempts` (0051), and a job is       │
 * │ 'failed' precisely because it spent them. Flipping status back to         │
 * │ 'queued' without resetting the counter produces a row that is queued,     │
 * │ visible, counted as in-flight by listJobs above — and matched by no claim │
 * │ query, ever. The retry reports success, the count moves, and the pages    │
 * │ are never OCR'd. 0051 names this as the plausible mistake and puts the    │
 * │ filter in the claim query to make sure it stops rather than spins.        │
 * │                                                                           │
 * │ `run_after` goes back to now for the same class of reason: a worker       │
 * │ records a failure by pushing run_after forward, so a retry that leaves it │
 * │ alone means "retry, in forty minutes", which is not what the button says. │
 * │                                                                           │
 * │ locked_at and locked_by are written as a PAIR because jobs_lock_is_whole  │
 * │ checks exactly that — `(locked_at is null) = (locked_by is null)` — and a │
 * │ half-clear is a 23514 rather than a lock somebody has to reason about.    │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THREE STATUSES AND THREE KINDS ARE DELIBERATELY NOT SWEPT.                │
 * │                                                                           │
 * │ 'succeeded' — re-OCR'ing a page that already has text is the ninety       │
 * │ pages 0051 describes somebody redoing by hand, done automatically and     │
 * │ charged for.                                                              │
 * │ 'cancelled' — a person withdrew that job. A retry that resurrects a       │
 * │ withdrawal makes the cancel button conditional on nobody pressing this    │
 * │ one afterwards.                                                           │
 * │ 'blocked'   — not a failure at all. It resumes with the single statement  │
 * │ in 0051 once a provider key exists, and folding it in here would hide     │
 * │ "you have no AI provider" behind a button labelled "retry failed pages".  │
 * │                                                                           │
 * │ And `kind = 'ocr_page'`, because the name of this function is a promise.  │
 * │ A failed generate_questions job on the same document is a different       │
 * │ problem with a different cost, and sweeping it in silently would make     │
 * │ "retry the pages that failed" spend a generation call nobody asked for.   │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export async function retryFailedPages(
  documentId: string,
): Promise<MutationResult & { requeued?: number }> {
  await requirePermission('questions.import')

  const parsed = dbId().safeParse(documentId)
  if (!parsed.success) return { ok: false, error: 'Invalid document.' }

  const supabase = jobsDb(await createClient())
  const { error, count } = await supabase
    .from('jobs')
    .update(
      {
        status: 'queued',
        attempts: 0,
        run_after: new Date().toISOString(),
        // Cleared so the bank does not show yesterday's error against a job
        // that is queued again. The failure is not lost: import_batches holds
        // the durable record of the run (0048), which is where a history that
        // outlives a retry belongs.
        last_error: null,
        locked_at: null,
        locked_by: null,
      },
      { count: 'exact' },
    )
    .eq('source_document_id', parsed.data)
    .eq('kind', 'ocr_page')
    .eq('status', 'failed')

  if (error) return { ok: false, error: 'Could not re-queue these pages.' }
  // Zero is not success. It means one of "nothing failed", "not your document"
  // or "somebody retried thirty seconds ago" — and the wording below is true
  // under all three, which is the honest way to report a count check that
  // cannot distinguish them. What it must never say is "12 pages re-queued".
  if (count === 0) return { ok: false, error: 'No failed pages were re-queued.' }

  revalidatePath('/guide')
  return { ok: true, requeued: count ?? 0 }
}
