import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  CANCELLABLE_STATUSES,
  IN_FLIGHT_STATUSES,
  JOB_KINDS,
  JOB_PAYLOAD_SCHEMAS,
  JOB_STATUSES,
  emptyJobCounts,
  inFlightJobs,
  isCancellableStatus,
  isInFlightStatus,
  jobKindSchema,
  jobStatusSchema,
  parseJobPayload,
  unaccountedJobs,
  type JobKind,
} from '../../src/lib/jobs/types'

/**
 * The queue vocabulary against the constraint it claims to mirror.
 *
 * Two files in two languages say what a job kind and a job status are, and
 * nothing but this test stops them diverging. Both directions are checked
 * because neither alone is an assertion:
 *
 *   · SQL → TS only  passes against a TypeScript vocabulary that allows
 *                    everything, including values the CHECK rejects with a
 *                    23514 on the enqueue path, where 0051 notes nobody is
 *                    watching.
 *   · TS → SQL only  passes against one that allows nothing, which makes every
 *                    kind unreachable from the product and every worker branch
 *                    dead code that looks written.
 *
 * The pair is the assertion — the same rule question-status-parity.test.ts
 * states for the question lifecycle. This one is a unit test rather than an RLS
 * test because it needs no database: the constraint is text in a migration file
 * that has not been applied yet, and text is exactly what can be read here.
 */

const MIGRATION = resolve(
  __dirname,
  '../../supabase/migrations/20260803110000_0051_jobs.sql',
)

/**
 * The migration with its prose removed.
 *
 * Not because a comment currently defeats the pattern below — 0051 quotes
 * `status = 'queued'` and `where status = 'blocked'` inside its boxes, and
 * neither is an `in (…)` list. It is because the file argues its case by
 * quoting the very values under test, so the next box added is one
 * `status in (…)` away from being read as the constraint. Stripping first makes
 * that impossible rather than lucky.
 */
const statements = readFileSync(MIGRATION, 'utf8')
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n')

/**
 * The values one CHECK admits, as the migration writes them.
 *
 * `[^)]*` spans newlines on purpose: the kind list is wrapped across three
 * lines and a dot-based pattern would stop at the first of them and report a
 * shorter vocabulary than the constraint has.
 */
function checkedValues(column: 'kind' | 'status'): string[] {
  const match = new RegExp(`\\b${column} in \\(([^)]*)\\)`).exec(statements)
  if (!match) return []
  return [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1])
}

describe('the job vocabulary', () => {
  const kindsInSql = checkedValues('kind')
  const statusesInSql = checkedValues('status')

  /**
   * ┌───────────────────────────────────────────────────────────────────────┐
   * │ THE CONTROL FOR EVERY ASSERTION BELOW.                                │
   * │                                                                       │
   * │ checkedValues returns [] when its pattern stops matching — a renamed  │
   * │ file, a reformatted CHECK, an `in` written as `= any(array[…])`. An   │
   * │ empty list makes "TS allows everything SQL allows" trivially true,    │
   * │ and this file would then guard nothing while still passing green      │
   * │ through every change to either side.                                  │
   * │                                                                       │
   * │ So the first thing asserted is that the migration was read and that   │
   * │ two specific values came out of it.                                   │
   * └───────────────────────────────────────────────────────────────────────┘
   */
  it('finds both CHECK lists in the migration at all', () => {
    expect(kindsInSql.length).toBeGreaterThan(1)
    expect(statusesInSql.length).toBeGreaterThan(1)
    expect(kindsInSql).toContain('ocr_page')
    expect(statusesInSql).toContain('blocked')
  })

  it('admits every kind 0051 admits', () => {
    for (const kind of kindsInSql) {
      expect(jobKindSchema.safeParse(kind).success, kind).toBe(true)
    }
  })

  it('admits no kind 0051 does not', () => {
    for (const kind of JOB_KINDS) {
      expect(kindsInSql, kind).toContain(kind)
    }
    expect([...JOB_KINDS].sort()).toEqual([...kindsInSql].sort())
  })

  it('admits every status 0051 admits', () => {
    for (const status of statusesInSql) {
      expect(jobStatusSchema.safeParse(status).success, status).toBe(true)
    }
  })

  it('admits no status 0051 does not', () => {
    for (const status of JOB_STATUSES) {
      expect(statusesInSql, status).toContain(status)
    }
    expect([...JOB_STATUSES].sort()).toEqual([...statusesInSql].sort())
  })

  /**
   * The near miss, asserted by name because it is the one that would compile.
   * import_batches (0048) is 'queued','running','completed','failed','reverted'
   * — four of five words look like this table's and two are wrong. A job is
   * 'succeeded', never 'completed', and is never 'reverted' at all.
   */
  it('does not answer to import_batches’ vocabulary', () => {
    expect(jobStatusSchema.safeParse('completed').success).toBe(false)
    expect(jobStatusSchema.safeParse('reverted').success).toBe(false)
    expect(statusesInSql).not.toContain('completed')
  })
})

describe('job payloads', () => {
  /**
   * One valid example per kind, as a total Record so that adding a kind to
   * JOB_KINDS fails to compile here as well as in the schema table.
   */
  const validPayload: Record<JobKind, unknown> = {
    ocr_page: { language: 'en' },
    extract_knowledge: { pageFrom: 1, pageTo: 12 },
    generate_questions: { count: 10, bloomLevels: ['apply', 'analyze'] },
    extract_question_paper: { pageFrom: 1, pageTo: 4 },
  }

  /**
   * The positive control. Without it every rejection test below passes against
   * a parseJobPayload that refuses everything — and a queue whose enqueue path
   * refuses every payload is one that never has any work in it, which reads
   * from the outside exactly like an idle queue.
   */
  it('accepts a payload that is right, for every kind', () => {
    for (const kind of JOB_KINDS) {
      expect(parseJobPayload(kind, validPayload[kind]).ok, kind).toBe(true)
    }
  })

  it('has a schema for every kind and for nothing else', () => {
    expect(Object.keys(JOB_PAYLOAD_SCHEMAS).sort()).toEqual([...JOB_KINDS].sort())
  })

  /**
   * 0051 gave up a 23502 at insert to get one lifecycle that cannot drift, and
   * said so. This is the compensation, so it has to actually refuse something.
   */
  it('refuses a generation request with nothing to generate from', () => {
    const missingBloom = parseJobPayload('generate_questions', { count: 10 })
    expect(missingBloom.ok).toBe(false)

    const emptyBloom = parseJobPayload('generate_questions', { count: 10, bloomLevels: [] })
    expect(emptyBloom.ok).toBe(false)

    // `analyse` is the spelling a provider that has never read the Postgres
    // enum would use. metadata.ts exists because of exactly this.
    const wrongSpelling = parseJobPayload('generate_questions', {
      count: 10,
      bloomLevels: ['analyse'],
    })
    expect(wrongSpelling.ok).toBe(false)
  })

  /**
   * An inverted range is not an error further down: it selects no pages, so the
   * job runs, extracts nothing, and reports 'succeeded'. A document that
   * silently produced zero knowledge units looks identical to one the provider
   * had nothing to say about.
   */
  it('refuses a page range that runs backwards', () => {
    const result = parseJobPayload('extract_knowledge', { pageFrom: 12, pageTo: 3 })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain('pageTo')
      // The kind is in the message because this string lands in jobs.last_error,
      // where 0051 says the 2am question — "why is page 90 not done" — is
      // answered. "Invalid payload" answers nobody.
      expect(result.error).toContain('extract_knowledge')
    }
  })

  it('refuses one kind’s payload under another kind', () => {
    expect(parseJobPayload('extract_knowledge', validPayload.generate_questions).ok).toBe(false)
    expect(parseJobPayload('generate_questions', validPayload.extract_knowledge).ok).toBe(false)
  })

  /**
   * Stated as a test rather than left to be discovered: ocr_page has no
   * required field, because everything it needs is reachable through
   * document_page_id and a second copy of a page number is a fact that can
   * disagree with itself. `{}` is therefore a valid payload, and 0051's
   * `jsonb_typeof(payload) = 'object'` is what still refuses the values that
   * genuinely are not payloads.
   */
  it('accepts an empty object for ocr_page, which is the whole design', () => {
    expect(parseJobPayload('ocr_page', {}).ok).toBe(true)
    expect(parseJobPayload('ocr_page', null).ok).toBe(false)
    expect(parseJobPayload('ocr_page', 3).ok).toBe(false)
  })
})

describe('the status subsets', () => {
  it('treats what the queue moves on its own as in flight', () => {
    for (const status of IN_FLIGHT_STATUSES) {
      expect(isInFlightStatus(status), status).toBe(true)
    }
  })

  it('treats no other status as in flight, blocked above all', () => {
    const notInFlight = JOB_STATUSES.filter(
      (s) => !(IN_FLIGHT_STATUSES as readonly string[]).includes(s),
    )
    // If this list ever empties, something has made every status in flight and
    // the progress bar has stopped meaning anything.
    expect(notInFlight.length).toBeGreaterThan(0)
    for (const status of notInFlight) {
      expect(isInFlightStatus(status), status).toBe(false)
    }
    // By name as well as by property, because this specific value is the one
    // that would leave a queue with no AI provider spinning at 99% forever
    // instead of saying that it is waiting for a key.
    expect(isInFlightStatus('blocked')).toBe(false)
  })

  it('cancels what has not started', () => {
    for (const status of CANCELLABLE_STATUSES) {
      expect(isCancellableStatus(status), status).toBe(true)
    }
    // 'blocked' by name: withdrawing a wait is the reason cancellation exists
    // at all, and a queue with no key is entirely blocked rows.
    expect(isCancellableStatus('blocked')).toBe(true)
  })

  /**
   * ┌───────────────────────────────────────────────────────────────────────┐
   * │ THE ONE THIS PINS.                                                    │
   * │                                                                       │
   * │ Nothing in this codebase can interrupt a worker that is already       │
   * │ inside a provider call. Marking a claimed row 'cancelled' does not    │
   * │ stop it — the worker finishes and writes 'succeeded' or 'failed' over │
   * │ the top, and the cancellation vanishes with no error anywhere.        │
   * │                                                                       │
   * │ cancelJob's `.in('status', CANCELLABLE_STATUSES)` is what turns that  │
   * │ into an honest zero row count, and this is what keeps 'running' out   │
   * │ of the list the day somebody adds it because the button looked        │
   * │ inconsistent.                                                         │
   * └───────────────────────────────────────────────────────────────────────┘
   */
  it('never offers to cancel a job a worker is holding', () => {
    expect(isCancellableStatus('running')).toBe(false)
    expect(CANCELLABLE_STATUSES as readonly string[]).not.toContain('running')
  })

  it('never offers to cancel a job that has already finished', () => {
    expect(isCancellableStatus('succeeded')).toBe(false)
    expect(isCancellableStatus('failed')).toBe(false)
    expect(isCancellableStatus('cancelled')).toBe(false)
  })
})

describe('counting', () => {
  it('starts every status at zero', () => {
    const counts = emptyJobCounts()
    expect(Object.keys(counts).sort()).toEqual([...JOB_STATUSES].sort())
    for (const status of JOB_STATUSES) {
      expect(counts[status], status).toBe(0)
    }
  })

  it('hands out a fresh object, so one document cannot count into the next', () => {
    const first = emptyJobCounts()
    first.succeeded = 12
    expect(emptyJobCounts().succeeded).toBe(0)
    expect(emptyJobCounts()).not.toBe(first)
  })

  it('leaves blocked out of the in-flight sum', () => {
    const counts = emptyJobCounts()
    counts.queued = 5
    counts.running = 1
    counts.blocked = 107
    expect(inFlightJobs(counts)).toBe(6)
  })

  /**
   * What drift looks like from the progress bar's side, and the reason listJobs
   * reads `total` from the database instead of summing the six.
   *
   * A status added to 0051's CHECK and not to JOB_STATUSES is invisible to
   * every count above. Summing would make the bar quietly short of the truth;
   * this makes the gap a number somebody can be shown.
   */
  it('reports jobs in a status this vocabulary cannot name', () => {
    const counts = emptyJobCounts()
    counts.succeeded = 90
    expect(unaccountedJobs(113, counts)).toBe(23)
  })

  it('never reports a negative, because the counts are separate reads', () => {
    const counts = emptyJobCounts()
    counts.succeeded = 5
    // An insert landing between the total and the per-status counts. Transient,
    // and it must not render as "-2 unaccounted".
    expect(unaccountedJobs(3, counts)).toBe(0)
  })
})
