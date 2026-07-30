import { z } from 'zod'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The question lifecycle, in one place.
 *
 * Before this, the vocabulary was spelled out independently in five layers and
 * three of them disagreed:
 *
 *   · the Postgres enum          7 values (0037)
 *   · messages/*.json            3 values, so a question in `review` rendered
 *                                the literal string `questions.status.review`
 *   · questionFiltersSchema      3 values
 *   · setQuestionStatus's schema 3 values
 *   · question-form's buttons    2 values, hard-coded
 *
 * A status that four of the five layers reject is not a status, and a status
 * only the database knows about is worse than none — 0037 added four of them
 * and one, `approved`, silently removed a question from every exam paper.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ TRANSITIONS ARE MIRRORED FROM SQL, NOT OWNED HERE.                        │
 * │                                                                           │
 * │ Migration 0040's question_status_transition_allowed() is authoritative and │
 * │ enforced by a trigger, so this table cannot permit anything the database   │
 * │ will accept — at worst it offers a button that then fails loudly.         │
 * │                                                                           │
 * │ It exists so the editor can offer the moves that are legal FROM WHERE YOU  │
 * │ ARE rather than a fixed pair, and tests/unit/question-status.test.ts pins  │
 * │ the two copies against each other.                                        │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Every value in the Postgres enum, in its declared order. */
export const QUESTION_STATUSES = [
  'draft',
  'review',
  'active',
  'approved',
  'retired',
  'archived',
  'deprecated',
] as const

export type QuestionStatusValue = (typeof QUESTION_STATUSES)[number]

export const questionStatusSchema = z.enum(QUESTION_STATUSES)

/**
 * Mirrors question_status_transition_allowed() in 0040.
 *
 * `approved` and `active` are both drawable — see question_is_drawable(). The
 * pair exists because Postgres cannot drop an enum value once added, so the two
 * labels 0037 created are permanent whether or not anybody wanted both.
 */
export const QUESTION_STATUS_TRANSITIONS: Record<QuestionStatusValue, QuestionStatusValue[]> = {
  // Review is available, not compulsory: draft -> active is the common path for
  // a chef who is both author and approver.
  draft: ['review', 'active', 'archived'],
  review: ['draft', 'approved', 'archived'],
  approved: ['active', 'draft', 'retired', 'archived'],
  active: ['retired', 'archived'],
  // The reversible withdrawal. `draft` is here because "Return to draft" is a
  // button the editor has always had; archived and deprecated are not reversible.
  retired: ['draft', 'active', 'approved', 'archived', 'deprecated'],
  archived: ['deprecated'],
  deprecated: [],
}

export function nextStatuses(from: QuestionStatusValue): QuestionStatusValue[] {
  return QUESTION_STATUS_TRANSITIONS[from] ?? []
}

/**
 * The statuses from which a question can be drawn onto a paper.
 *
 * Mirrors `question_is_drawable()` (0040), and
 * tests/integration/question-status-parity.test.ts asserts the two agree.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THIS IS WHAT THE PUBLISH GATE KEYS ON — NOT THE LITERAL 'active'.         │
 * │                                                                           │
 * │ 0040 made `approved` drawable alongside `active`, and setQuestionStatus    │
 * │ routed only `active` through publishQuestion. So a question with a broken  │
 * │ answer key — one naming an option id that no longer exists — could go      │
 * │ draft → review → approved and be drawn onto a live paper, having never     │
 * │ passed publishIssues. Marking every candidate wrong, with no error         │
 * │ anywhere.                                                                 │
 * │                                                                           │
 * │ Before 0040 that path was inert, because `approved` was not drawable.      │
 * │ 0040 made it live. Keying the gate on drawability rather than on one       │
 * │ status name is what stops the next added status reopening it.              │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export const DRAWABLE_STATUSES = ['active', 'approved'] as const

export function isDrawableStatus(status: QuestionStatusValue): boolean {
  return (DRAWABLE_STATUSES as readonly string[]).includes(status)
}

/**
 * Which permission a move requires.
 *
 * Three families:
 *   · `active`  — publishing. Goes through publishQuestion(), which runs the
 *                 strict validation gate; a question with a broken answer key
 *                 must not become drawable.
 *   · withdrawal — retired / archived / deprecated, all `questions.retire`.
 *   · authoring  — draft / review / approved, all `questions.update`.
 *
 * KNOWN GAP, stated rather than hidden: `approved` sits under `questions.update`
 * because no approval permission exists. That is more permissive than a real
 * governance workflow would be — but it is not MORE permissive than today,
 * because anybody holding questions.update can already make a question `active`
 * via publishQuestion, and active and approved are equally drawable. A genuine
 * `questions.approve` belongs with the exam approval workflow (M10), not
 * invented here.
 */
export function permissionForStatus(to: QuestionStatusValue): 'questions.update' | 'questions.retire' {
  return to === 'retired' || to === 'archived' || to === 'deprecated'
    ? 'questions.retire'
    : 'questions.update'
}
