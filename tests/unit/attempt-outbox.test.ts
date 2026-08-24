import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  acknowledgeAnswer,
  clearOutbox,
  pendingAnswers,
  queueAnswer,
  readOutbox,
} from '@/lib/attempts/outbox'
import type { AnswerPayload } from '@/lib/questions/schemas'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The queue that stands between a candidate and a lost answer.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ WHAT THIS IS DEFENDING AGAINST.                                           ║
 * ║                                                                           ║
 * ║ Before the outbox, a failed save set an indicator and stopped. The answer ║
 * ║ existed only in React state, so a reload during a timed exam took it —    ║
 * ║ and the indicator said "retrying" while nothing retried.                  ║
 * ║                                                                           ║
 * ║ Every assertion here is about one rule: an entry leaves this queue ONLY   ║
 * ║ when the server has acknowledged that exact payload. Anything else in     ║
 * ║ here is work the server does not have.                                    ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */

const ATTEMPT = 'attempt-1'
const OTHER = 'attempt-2'

const choice = (c: string): AnswerPayload => ({ format: 'choice_single', choice: c })
const text = (t: string): AnswerPayload => ({ format: 'text_short', text: t })

/** A minimal localStorage, because vitest runs in node by default. */
function installStorage() {
  const store = new Map<string, string>()
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    },
  })
  return store
}

beforeEach(() => {
  installStorage()
})

describe('queueing and acknowledging', () => {
  it('holds an answer until the server confirms it', () => {
    queueAnswer(ATTEMPT, 'q1', choice('B'))
    expect(pendingAnswers(ATTEMPT)).toEqual([['q1', choice('B')]])

    acknowledgeAnswer(ATTEMPT, 'q1', choice('B'))
    expect(pendingAnswers(ATTEMPT)).toEqual([])
  })

  it('keeps the NEWER answer when one is acknowledged late', () => {
    /*
     * The race this exists for: a save for "B" is in flight, the candidate
     * changes to "C", then the "B" response arrives. Clearing on the response
     * would discard "C" — silently, and with everything looking saved.
     */
    queueAnswer(ATTEMPT, 'q1', choice('B'))
    queueAnswer(ATTEMPT, 'q1', choice('C'))

    acknowledgeAnswer(ATTEMPT, 'q1', choice('B'))

    expect(pendingAnswers(ATTEMPT)).toEqual([['q1', choice('C')]])
  })

  it('acknowledging something never queued does nothing', () => {
    queueAnswer(ATTEMPT, 'q1', choice('A'))
    acknowledgeAnswer(ATTEMPT, 'q-other', choice('A'))
    expect(pendingAnswers(ATTEMPT)).toEqual([['q1', choice('A')]])
  })

  it('overwrites rather than appends for the same question', () => {
    queueAnswer(ATTEMPT, 'q1', text('first'))
    queueAnswer(ATTEMPT, 'q1', text('second'))
    queueAnswer(ATTEMPT, 'q1', text('third'))

    expect(pendingAnswers(ATTEMPT)).toEqual([['q1', text('third')]])
  })

  it('holds many questions at once', () => {
    queueAnswer(ATTEMPT, 'q1', choice('A'))
    queueAnswer(ATTEMPT, 'q2', text('an answer'))
    queueAnswer(ATTEMPT, 'q3', choice('D'))

    expect(pendingAnswers(ATTEMPT)).toHaveLength(3)

    acknowledgeAnswer(ATTEMPT, 'q2', text('an answer'))
    expect(pendingAnswers(ATTEMPT).map(([id]) => id)).toEqual(['q1', 'q3'])
  })
})

describe('survives what it exists to survive', () => {
  it('a reload — the queue is read back from storage, not from memory', () => {
    queueAnswer(ATTEMPT, 'q1', text('half a sentence'))

    // A fresh read is what a remounted component does. Nothing is cached.
    expect(readOutbox(ATTEMPT)).toEqual({ q1: text('half a sentence') })
  })

  it('keeps two attempts apart', () => {
    // Two exams in two tabs must not share a queue, or one submit clears both.
    queueAnswer(ATTEMPT, 'q1', choice('A'))
    queueAnswer(OTHER, 'q1', choice('B'))

    expect(readOutbox(ATTEMPT)).toEqual({ q1: choice('A') })
    expect(readOutbox(OTHER)).toEqual({ q1: choice('B') })

    clearOutbox(ATTEMPT)
    expect(readOutbox(ATTEMPT)).toEqual({})
    expect(readOutbox(OTHER)).toEqual({ q1: choice('B') })
  })

  it('a corrupt queue reads as empty rather than breaking the exam', () => {
    window.localStorage.setItem(`bookends.attempt.${ATTEMPT}.outbox`, '{not json')
    expect(readOutbox(ATTEMPT)).toEqual({})

    // And is still writable afterwards — a bad value must not wedge it.
    queueAnswer(ATTEMPT, 'q1', choice('A'))
    expect(pendingAnswers(ATTEMPT)).toEqual([['q1', choice('A')]])
  })

  it('a non-object payload reads as empty', () => {
    window.localStorage.setItem(`bookends.attempt.${ATTEMPT}.outbox`, '["unexpected"]')
    expect(readOutbox(ATTEMPT)).toEqual({})
  })

  it('storage that throws degrades to no queue instead of crashing', () => {
    /*
     * Safari in private mode throws on setItem. A candidate mid-exam must not
     * be stopped by that — they get the old behaviour, which is what they
     * would have had without an outbox at all.
     */
    vi.stubGlobal('window', {
      localStorage: {
        getItem: () => {
          throw new Error('denied')
        },
        setItem: () => {
          throw new Error('denied')
        },
        removeItem: () => {
          throw new Error('denied')
        },
      },
    })

    expect(() => queueAnswer(ATTEMPT, 'q1', choice('A'))).not.toThrow()
    expect(readOutbox(ATTEMPT)).toEqual({})
    expect(() => clearOutbox(ATTEMPT)).not.toThrow()
  })
})

describe('clearing on submit', () => {
  it('empties the queue so a closed attempt is not retried forever', () => {
    queueAnswer(ATTEMPT, 'q1', choice('A'))
    queueAnswer(ATTEMPT, 'q2', choice('B'))

    clearOutbox(ATTEMPT)

    expect(pendingAnswers(ATTEMPT)).toEqual([])
  })

  it('removes the storage key entirely once the last answer lands', () => {
    // Not just an empty object left behind: a device holding a hundred finished
    // attempts should not be carrying a hundred empty records.
    queueAnswer(ATTEMPT, 'q1', choice('A'))
    acknowledgeAnswer(ATTEMPT, 'q1', choice('A'))

    expect(window.localStorage.getItem(`bookends.attempt.${ATTEMPT}.outbox`)).toBeNull()
  })
})
