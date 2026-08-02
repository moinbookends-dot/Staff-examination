import { z } from 'zod'
import { dbId } from '@/lib/db/id'
import { bloomLevelSchema } from '@/lib/questions/metadata'
import { questionTypeSchema } from '@/lib/questions/schemas'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The job queue's vocabulary, mirrored from 0051.
 *
 * This file is written BEFORE the layers that will spell these words, which is
 * the one thing status.ts could not do. That file arrived after five layers had
 * already been written independently and three of them disagreed:
 *
 *   · the Postgres enum          7 values (0037)
 *   · messages/*.json            3 values
 *   · questionFiltersSchema      3 values
 *   · setQuestionStatus's schema 3 values
 *   · question-form's buttons    2 values, hard-coded
 *
 * The layers that will spell a job kind or a job status do not exist yet — the
 * worker, the enqueue path, the progress bar, and whatever renders `blocked` to
 * a chef who is waiting. Every one of them imports from here or it is wrong,
 * and there is nothing to reconcile because there is nothing else to reconcile
 * with. 0051's closing line is the instruction this file executes:
 *
 *     When a JOB_KINDS / JOB_STATUSES vocabulary lands in src/lib (it will —
 *     see SOURCE_DOCUMENT_KINDS in src/lib/imports/source-documents.ts, kept
 *     one for one with 0050's CHECK), keep it one for one with the two CHECKs
 *     above.
 *
 * tests/unit/job-types.test.ts reads the migration and pins both directions.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * The four units of work, in the CHECK's declared order.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ ONE FOR ONE WITH 0051's kind CHECK, IN BOTH DIRECTIONS.                   │
 * │                                                                           │
 * │ The same contract SOURCE_DOCUMENT_KINDS holds against 0050, and it fails  │
 * │ the same two ways. A kind the CHECK admits but this array omits is        │
 * │ unreachable from the product: nothing can enqueue it, so a worker branch  │
 * │ written for it never runs and the feature ships dead. A kind here that    │
 * │ the CHECK does not admit is worse — it survives every check in            │
 * │ TypeScript, reaches the insert, and comes back as a bare 23514 on the     │
 * │ enqueue path, which 0051 points out is exactly where nobody is watching.  │
 * │                                                                           │
 * │ 0051's own words for why this set is closed rather than open: the worker  │
 * │ SWITCHES on this value, so a kind with no branch behind it is not an      │
 * │ extension point — it is a row that is claimed, cannot be executed, and    │
 * │ burns its attempts finding out.                                           │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export const JOB_KINDS = [
  'ocr_page',
  'extract_knowledge',
  'generate_questions',
  // The second road from 0050. A past paper is already questions, so it never
  // gets an extract_knowledge job at all and never reaches generation.
  'extract_question_paper',
] as const

export type JobKind = (typeof JOB_KINDS)[number]

export const jobKindSchema = z.enum(JOB_KINDS)

/**
 * The queue lifecycle, in the CHECK's declared order.
 *
 * Deliberately NOT import_batches.status (0048), for the reason 0051 gives: a
 * batch is 'reverted', which a job never is, and a job is 'blocked', which a
 * batch never is. Two vocabularies that are nearly the same are still two, and
 * the near-miss is what makes them get copied into each other.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ 'blocked' IS NOT 'failed', AND EVERY SUBSET BELOW TURNS ON THAT.          │
 * │                                                                           │
 * │ A job that cannot run because no AI provider is configured has not        │
 * │ failed: nothing was attempted, nothing went wrong, and the payload is     │
 * │ still exactly as good as it was. 'failed' means the attempts were spent   │
 * │ and a person must now decide something; 'blocked' means wait.             │
 * │                                                                           │
 * │ The cost of folding them together is counted in 0051 and it is 113 pages  │
 * │ of hand work — a cookbook uploaded with no key set leaves 113 FAILED rows │
 * │ for somebody to re-queue one at a time, which is precisely the moment     │
 * │ ninety already-done pages get OCR'd again or twenty get missed.           │
 * │                                                                           │
 * │ So no helper in this file may quietly treat the two as one. IN_FLIGHT     │
 * │ excludes 'blocked' because a blocked job never moves on its own;          │
 * │ CANCELLABLE includes it because withdrawing a wait is the whole point of  │
 * │ being able to withdraw; and retryFailedPages touches 'failed' only.       │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export const JOB_STATUSES = [
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
  'blocked',
] as const

export type JobStatus = (typeof JOB_STATUSES)[number]

export const jobStatusSchema = z.enum(JOB_STATUSES)

/**
 * The statuses the queue will move without anybody doing anything.
 *
 * This is what a progress bar means by "still going". 'blocked' is deliberately
 * absent and that is the whole content of this constant: a blocked job is
 * waiting on an operator setting a key, not on a worker, so counting it as
 * in-flight produces a spinner that never stops and a number that never moves.
 * 'failed' is absent for the same reason in the other direction — it moves only
 * when a human presses retry.
 */
export const IN_FLIGHT_STATUSES = ['queued', 'running'] as const

export function isInFlightStatus(status: JobStatus): boolean {
  return (IN_FLIGHT_STATUSES as readonly string[]).includes(status)
}

/**
 * What cancelJob may withdraw.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ 'running' IS NOT CANCELLABLE, AND OFFERING IT WOULD BE A LIE.             │
 * │                                                                           │
 * │ Nothing here can stop a worker that is already inside a provider call.    │
 * │ Setting a claimed row to 'cancelled' does not interrupt it; the worker    │
 * │ finishes, writes 'succeeded' or 'failed' over the top, and the            │
 * │ cancellation disappears with no error anywhere. A button that reports     │
 * │ success and is then silently undone is worse than no button.              │
 * │                                                                           │
 * │ It is also not the thing anybody actually wants. Cancelling a 113-page    │
 * │ run means "stop spending money on this document" — and cancelling every   │
 * │ QUEUED page does exactly that. The one page in flight finishes, the other │
 * │ 112 never start. Stopping the 113th costs a kill switch the worker does   │
 * │ not have, to save one page of work.                                       │
 * │                                                                           │
 * │ Neither of these two holds a lock, which is why cancelJob writes `status` │
 * │ alone: there is no locked_at/locked_by pair to clear, and jobs_lock_is_   │
 * │ whole is satisfied by not touching a lock that was already whole.         │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export const CANCELLABLE_STATUSES = ['queued', 'blocked'] as const

export function isCancellableStatus(status: JobStatus): boolean {
  return (CANCELLABLE_STATUSES as readonly string[]).includes(status)
}

// ─────────────────────────────────────────────────────────────────────────────
// Payloads
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THIS SECTION IS WHERE THE TYPE 0051 GAVE UP IS BOUGHT BACK.               │
 * │                                                                           │
 * │ 0051 chose one jobs table over four, and stated the price rather than     │
 * │ hiding it: per-kind tables could have typed the payload as real columns   │
 * │ with real foreign keys, so a malformed job would be a 23502 at insert.    │
 * │ With one table it is a runtime failure recorded in last_error — "a worse  │
 * │ error, later, in exchange for one lifecycle that cannot drift".           │
 * │                                                                           │
 * │ These schemas make "later" survivable. Every enqueue parses its payload   │
 * │ here first, so the malformed job is refused before a row exists, and      │
 * │ every worker parses it again on claim, so a row that got in another way   │
 * │ fails with a sentence instead of a stack trace.                           │
 * │                                                                           │
 * │ WHAT THIS IS NOT, said plainly: it is not a constraint. A row written by  │
 * │ psql, or by a future service that skips this file, is still whatever it   │
 * │ says it is — 0051's jsonb_typeof CHECK is the only thing the database     │
 * │ itself promises. That is the trade, and it was made in the migration.     │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * The keys below are camelCase, unlike JobRow's, because they are ours: a
 * payload key is a name this codebase invented for a jsonb field, not a column.
 * Same rule the provider payloads follow in src/lib/ai/provider.ts.
 */

/**
 * Carried by every kind: what the enqueuer decided this run should use.
 *
 * Optional throughout, because the registry (src/lib/ai/registry.ts) chooses
 * when they are absent. Present when a run must be reproducible or purgeable —
 * pinning the model on the job is what lets somebody six weeks later find every
 * row that came out of one particular model, which is the same second handle
 * mock-provider.ts leaves behind in document_pages.ocr_model.
 */
const runHints = {
  model: z.string().trim().min(1).max(120).optional(),
  promptVersion: z.string().trim().min(1).max(40).optional(),
}

/**
 * A page range within one document, used by the two kinds that read prose.
 *
 * Refined rather than left to the worker: an inverted range is not an error
 * anywhere downstream, it simply selects no pages — so the job runs, extracts
 * nothing, and reports 'succeeded'. A document that quietly produced zero
 * knowledge units looks identical to one the provider had nothing to say about.
 */
const pageRange = {
  pageFrom: z.number().int().positive(),
  pageTo: z.number().int().positive(),
}

const rangeIsForwards = <T extends { pageFrom: number; pageTo: number }>(value: T): boolean =>
  value.pageFrom <= value.pageTo

/**
 * `error:` and not `message:`, which Zod 4 marks deprecated. exam rules.ts
 * carries the identical refinement written the old way — it predates the
 * notice, and this is the spelling anything new should copy.
 */
const RANGE_REFINEMENT = {
  error: 'pageTo must not be before pageFrom.',
  // Not `as const`: Zod's params type wants a mutable PropertyKey[], and a
  // readonly tuple is not assignable to it.
  path: ['pageTo'],
}

/**
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE THIN PAYLOAD IS ocr_page's CORRECT PAYLOAD.                           │
 * │                                                                           │
 * │ It looks underspecified next to the other three, and it is not. 0051 says │
 * │ payload holds "what the worker needs that is not already reachable        │
 * │ through the links", and for this kind almost nothing qualifies:           │
 * │ document_page_id gives the worker the page number, the image path and the │
 * │ document, all as columns with foreign keys behind them.                   │
 * │                                                                           │
 * │ Restating any of them here would create a second copy of a fact that      │
 * │ already exists, and the failure mode of that copy is a job whose payload  │
 * │ says page 12 while its link points at page 13. There is no version of     │
 * │ that bug that is easy to find.                                            │
 * │                                                                           │
 * │ So `{}` is a valid ocr_page payload. 0051's `jsonb_typeof(payload) =      │
 * │ 'object'` is what still refuses `'null'::jsonb` and `'3'::jsonb`, which   │
 * │ are the values that are genuinely not payloads.                           │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export const ocrPagePayloadSchema = z.object({
  /**
   * A hint, not a promise. Some OCR providers accept a language and do better
   * with it; the ones that do not ignore it. BCP-47-ish and unvalidated beyond
   * length, because this is passed through to a vendor, not stored as a locale.
   */
  language: z.string().trim().min(2).max(12).optional(),
  ...runHints,
})

/**
 * Reading OCR'd pages into knowledge units.
 *
 * The range is required and is the reason this payload exists at all: one
 * document becomes many extract_knowledge jobs, and which pages each covers is
 * recorded nowhere else. source_document_id says which book; only this says
 * which chapter.
 */
export const extractKnowledgePayloadSchema = z
  .object({
    ...pageRange,
    ...runHints,
  })
  .refine(rangeIsForwards, RANGE_REFINEMENT)

/**
 * The generation request.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THIS IS THE SHAPE provider.ts DECLINED TO NAME.                           │
 * │                                                                           │
 * │ GenerateQuestionsInput.constraints is typed `unknown` there, deliberately │
 * │ — "constraints are what a chef asked for, and that shape belongs to M12's │
 * │ generation form", which did not exist. This is the first thing that has   │
 * │ to carry it: a queued generation job must remember what was asked for,    │
 * │ because the asking happened minutes or hours before the running.          │
 * │                                                                           │
 * │ The coupling runs one way and must stay that way. This file knows the     │
 * │ provider's nouns; provider.ts knows nothing about jobs. And parsing here  │
 * │ before handing the object over is exactly what `unknown` was chosen to    │
 * │ force — an adapter must parse it before it can read it.                   │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export const generateQuestionsPayloadSchema = z.object({
  /**
   * Capped, and the cap is a queue decision rather than a product one. One job
   * is one provider call: asking for 500 questions in a single call is one
   * timeout that fails the entire request, spends an attempt, and produces
   * nothing. Splitting a large ask across jobs is the enqueuer's job, and the
   * queue exists to make that cheap.
   */
  count: z.number().int().min(1).max(50),
  /**
   * bloomLevelSchema, never a hand-written list. metadata.ts exists because
   * QuestionSource was a hand-written union restating a Postgres CHECK, and a
   * provider free to be asked for `analyse` where the enum says `analyze` is
   * the same bug with a vendor holding the pen.
   */
  bloomLevels: z.array(bloomLevelSchema).min(1),
  /** Absent means "any type the generator can produce", not "none". */
  questionTypes: z.array(questionTypeSchema).min(1).optional(),
  /** Where the generated questions should be filed. Checked by the writer. */
  categoryId: dbId().optional(),
  ...runHints,
})

/**
 * Lifting questions off a past paper.
 *
 * Note what is NOT here: a `count`. You take what the paper has. Asking a
 * provider for N questions from a past paper is asking it to paraphrase an
 * exam, which is the thing 0050 refused when it kept 'question_paper' off the
 * generation road — the marks and the answers are the reason the paper was
 * worth keeping, and a paraphrase throws both away.
 */
export const extractQuestionPaperPayloadSchema = z
  .object({
    ...pageRange,
    ...runHints,
  })
  .refine(rangeIsForwards, RANGE_REFINEMENT)

/**
 * Kind → the schema its payload must satisfy.
 *
 * `Record<JobKind, …>` via `satisfies`, which is what makes adding a kind to
 * JOB_KINDS a build error here rather than a runtime surprise in the worker.
 * `satisfies` and not an annotation, so each value keeps its precise type and
 * JobPayloads below can infer through it.
 *
 * A `z.discriminatedUnion('kind', …)` over `{ kind, payload }` was the obvious
 * alternative and is not used: it would restate all four kind names a third
 * time, as literals TypeScript cannot check against JOB_KINDS. This table is
 * total by type and restates nothing.
 */
export const JOB_PAYLOAD_SCHEMAS = {
  ocr_page: ocrPagePayloadSchema,
  extract_knowledge: extractKnowledgePayloadSchema,
  generate_questions: generateQuestionsPayloadSchema,
  extract_question_paper: extractQuestionPaperPayloadSchema,
} satisfies Record<JobKind, z.ZodType>

/** The parsed payload for each kind, derived from the schemas above. */
export type JobPayloads = {
  [K in JobKind]: z.infer<(typeof JOB_PAYLOAD_SCHEMAS)[K]>
}

export type JobPayload<K extends JobKind = JobKind> = JobPayloads[K]

/**
 * Parse a payload against the schema for its kind.
 *
 * Returns a reason rather than throwing, because both callers need the sentence
 * and neither wants the stack: the enqueue path shows it to whoever pressed the
 * button, and the worker writes it into `last_error`, where 0051 says the
 * question at 2am — "why is page 90 not done" — is answered.
 */
export function parseJobPayload<K extends JobKind>(
  kind: K,
  payload: unknown,
): { ok: true; payload: JobPayloads[K] } | { ok: false; error: string } {
  const parsed = JOB_PAYLOAD_SCHEMAS[kind].safeParse(payload)
  if (parsed.success) {
    // The lookup widens to a union of four schemas, so `data` widens with it.
    // JOB_PAYLOAD_SCHEMAS is keyed by the same K, which is what makes this true.
    return { ok: true, payload: parsed.data as JobPayloads[K] }
  }
  const detail = parsed.error.issues
    .map((issue) => `${issue.path.join('.') || 'payload'}: ${issue.message}`)
    .join('; ')
  return { ok: false, error: `Invalid ${kind} payload — ${detail}` }
}

// ─────────────────────────────────────────────────────────────────────────────
// Rows and progress
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A job as the product reads it.
 *
 * snake_case throughout because every field here is literally a column in
 * public.jobs — the same split health.ts uses, where computed values are
 * camelCase and columns keep the name the database gave them.
 *
 * `payload` is absent on purpose. Nothing that lists jobs renders it, and a
 * jsonb column fetched into a list is bytes moved for nobody; the worker reads
 * it through parseJobPayload, one row at a time, which is the only place it
 * means anything.
 */
export interface JobRow {
  id: string
  kind: JobKind
  status: JobStatus
  attempts: number
  max_attempts: number
  run_after: string
  last_error: string | null
  source_document_id: string | null
  import_batch_id: string | null
  document_page_id: string | null
  created_at: string
  updated_at: string
}

/**
 * "42 of 113 pages OCR'd", as one object.
 *
 * The counts come straight off public.jobs — 0051's central argument for making
 * this queue client-readable at all is that a second progress table would be
 * one write away from saying 100% with nothing finished.
 */
export interface JobProgress {
  documentId: string
  /** Counted by the database over every job on the document, not summed here. */
  total: number
  byStatus: Record<JobStatus, number>
  /** queued + running. See IN_FLIGHT_STATUSES for why 'blocked' is not in it. */
  inFlight: number
  /**
   * total − the six counts. Must be zero.
   *
   * It is not zero when 0051's status CHECK has a value JOB_STATUSES does not,
   * which is the exact drift this file exists to prevent and the one direction
   * a unit test cannot catch after the fact. Surfacing it as a number means the
   * bar renders short and somebody asks why, rather than the bar quietly
   * reaching 100% while jobs nobody counted are still running.
   */
  unaccounted: number
}

/**
 * A fresh zero for every status.
 *
 * A function and not a module constant, deliberately: callers fill this in, and
 * a shared object would accumulate one document's counts into the next one's.
 */
export function emptyJobCounts(): Record<JobStatus, number> {
  const counts = {} as Record<JobStatus, number>
  for (const status of JOB_STATUSES) counts[status] = 0
  return counts
}

export function inFlightJobs(byStatus: Record<JobStatus, number>): number {
  return IN_FLIGHT_STATUSES.reduce((sum, status) => sum + (byStatus[status] ?? 0), 0)
}

export function countedJobs(byStatus: Record<JobStatus, number>): number {
  return JOB_STATUSES.reduce((sum, status) => sum + (byStatus[status] ?? 0), 0)
}

/**
 * How many jobs the database counted that this vocabulary could not name.
 *
 * Clamped at zero. A negative would mean the six counts exceeded the total,
 * which can only happen if the two reads straddled an insert — a transient
 * number, and one that must not render as "−2 unaccounted".
 */
export function unaccountedJobs(total: number, byStatus: Record<JobStatus, number>): number {
  return Math.max(0, total - countedJobs(byStatus))
}
