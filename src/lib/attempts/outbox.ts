import type { AnswerPayload } from '@/lib/questions/schemas'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Answers written to this device before they are written to the server.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE FAILURE THIS EXISTS TO PREVENT.                                       ║
 * ║                                                                           ║
 * ║ save_answer is a Server Action, and the runner used to treat a failed one ║
 * ║ as final: it set the indicator to "failed" and stopped. The answer lived  ║
 * ║ only in React state from then on, so a reload, a crash, or the phone      ║
 * ║ deciding to reclaim the tab took it with them — during a timed exam, with ║
 * ║ no way for the candidate to know which answers had actually landed.       ║
 * ║                                                                           ║
 * ║ Worse, the indicator read "Not saved — retrying" while nothing retried.   ║
 * ║                                                                           ║
 * ║ So: every answer is written HERE first, synchronously, and removed only   ║
 * ║ when the server has acknowledged that exact payload. Whatever is left in  ║
 * ║ here is, by definition, work the server does not have.                    ║
 * ║                                                                           ║
 * ║ localStorage rather than IndexedDB deliberately — the writes are tiny and ║
 * ║ must be SYNCHRONOUS. An async write that loses the race with the tab      ║
 * ║ closing is the exact bug this is here to fix.                             ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Every function swallows storage errors and degrades to "no outbox". Safari
 * in private mode throws on setItem, and a candidate mid-exam must not be
 * stopped by that — they simply get the old behaviour, which is what they
 * would have had anyway.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Scoped per attempt: two exams in two tabs must not share a queue. */
const keyFor = (attemptId: string) => `bookends.attempt.${attemptId}.outbox`

export type Outbox = Record<string, AnswerPayload>

export function readOutbox(attemptId: string): Outbox {
  try {
    const raw = window.localStorage.getItem(keyFor(attemptId))
    if (!raw) return {}

    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return parsed as Outbox
  } catch {
    // Unreadable or unparseable is the same as empty. A corrupt queue must not
    // be able to stop an exam from loading.
    return {}
  }
}

function write(attemptId: string, outbox: Outbox): void {
  try {
    if (Object.keys(outbox).length === 0) window.localStorage.removeItem(keyFor(attemptId))
    else window.localStorage.setItem(keyFor(attemptId), JSON.stringify(outbox))
  } catch {
    /* Full, or private mode. Nothing useful to do, and nothing worth interrupting for. */
  }
}

/** Record an answer as not-yet-on-the-server. Called before every network try. */
export function queueAnswer(attemptId: string, questionId: string, answer: AnswerPayload): void {
  const outbox = readOutbox(attemptId)
  outbox[questionId] = answer
  write(attemptId, outbox)
}

/**
 * Forget an answer, but ONLY if it is still the one that was acknowledged.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE COMPARISON IS THE POINT.                                              │
 * │                                                                           │
 * │ A save is in flight for a second or two, and a candidate can change their │
 * │ mind inside that window. Clearing the entry unconditionally on the        │
 * │ response would discard the NEWER answer, silently, and leave the older    │
 * │ one as the only record — the worst possible outcome, because everything   │
 * │ looks saved.                                                              │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export function acknowledgeAnswer(
  attemptId: string,
  questionId: string,
  answer: AnswerPayload,
): void {
  const outbox = readOutbox(attemptId)
  const pending = outbox[questionId]
  if (pending === undefined) return

  // Structural equality over a small, JSON-shaped payload. Key order is stable
  // because both sides were produced by the same renderer.
  if (JSON.stringify(pending) !== JSON.stringify(answer)) return

  delete outbox[questionId]
  write(attemptId, outbox)
}

/** Everything the server has not confirmed, oldest key order preserved. */
export function pendingAnswers(attemptId: string): [string, AnswerPayload][] {
  return Object.entries(readOutbox(attemptId))
}

/**
 * Drop the whole queue.
 *
 * Called after a successful submit, when the attempt is closed and the server
 * will refuse further writes anyway — keeping the entries would mean retrying
 * forever against an attempt that no longer accepts them.
 */
export function clearOutbox(attemptId: string): void {
  try {
    window.localStorage.removeItem(keyFor(attemptId))
  } catch {
    /* See write(). */
  }
}
