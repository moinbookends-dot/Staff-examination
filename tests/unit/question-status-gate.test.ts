import { describe, it, expect } from 'vitest'
import {
  DRAWABLE_STATUSES,
  isDrawableStatus,
  permissionForStatus,
  QUESTION_STATUSES,
  type QuestionStatusValue,
} from '../../src/lib/questions/status'

/**
 * The publish gate's trigger condition, and the permission mapping beside it.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE BUG THIS FILE EXISTS FOR.                                             │
 * │                                                                           │
 * │ setQuestionStatus used to read:                                           │
 * │                                                                           │
 * │     if (status === 'active') return publishQuestion(id)                   │
 * │     await requirePermission('questions.retire')                           │
 * │     // …bare update, no validation                                        │
 * │                                                                           │
 * │ Correct while `active` was the only drawable status. Migration 0040 made   │
 * │ `approved` drawable too, and at that moment a question whose answer key    │
 * │ named an option id that no longer exists could be moved                   │
 * │ draft → review → approved and drawn onto a live paper — grading every      │
 * │ candidate wrong, with no error anywhere.                                  │
 * │                                                                           │
 * │ The fix is not "also check for approved". It is to key the gate on         │
 * │ DRAWABILITY, so the next status added cannot reopen it. These tests pin    │
 * │ that property rather than the current membership of the list.              │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * tests/integration/question-status-parity.test.ts asserts DRAWABLE_STATUSES
 * agrees with question_is_drawable() in SQL. This file asserts what the
 * application does with it.
 */

describe('the publish gate', () => {
  it('treats every drawable status as one that must be validated', () => {
    for (const status of DRAWABLE_STATUSES) {
      expect(isDrawableStatus(status), status).toBe(true)
    }
  })

  it('treats no other status as drawable', () => {
    const notDrawable = QUESTION_STATUSES.filter(
      (s) => !(DRAWABLE_STATUSES as readonly string[]).includes(s),
    )
    // If this list ever empties, something has made every status drawable and
    // the gate has stopped meaning anything.
    expect(notDrawable.length).toBeGreaterThan(0)
    for (const status of notDrawable) {
      expect(isDrawableStatus(status), status).toBe(false)
    }
  })

  /**
   * The regression, stated as the thing that was false before the fix.
   * `approved` is drawable, so it must go through validation — asserting it by
   * name as well as by property, because this specific value is the one that
   * shipped broken.
   */
  it('requires validation for approved, not only for active', () => {
    expect(isDrawableStatus('active')).toBe(true)
    expect(isDrawableStatus('approved')).toBe(true)
  })
})

describe('permissionForStatus', () => {
  it('treats withdrawal as retire and authoring as update', () => {
    const expected: Record<QuestionStatusValue, string> = {
      draft: 'questions.update',
      review: 'questions.update',
      approved: 'questions.update',
      active: 'questions.update',
      retired: 'questions.retire',
      archived: 'questions.retire',
      deprecated: 'questions.retire',
    }
    for (const status of QUESTION_STATUSES) {
      expect(permissionForStatus(status), status).toBe(expected[status])
    }
  })

  /**
   * It was dead code until Step 4 — exported, documented, never imported —
   * while setQuestionStatus required `questions.retire` for everything that was
   * not `active`, including draft and review. Two rules for one decision, one
   * of them unreachable. Both paths now call this.
   */
  it('covers every status, so no caller can fall through', () => {
    for (const status of QUESTION_STATUSES) {
      expect(['questions.update', 'questions.retire']).toContain(permissionForStatus(status))
    }
  })
})
