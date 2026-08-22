import type { QuestionType } from '@/lib/bank/vocabulary'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The paper blueprint — how many of each question type a paper holds.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE 80/20 RATIO IS WRITTEN DOWN EXACTLY ONCE, HERE.                       ║
 * ║                                                                           ║
 * ║ 20 marks → 16 MCQ + 4 short.  50 marks → 40 MCQ + 10 short.               ║
 * ║                                                                           ║
 * ║ Both of those are DERIVED below, not listed. A table of hard-coded pairs  ║
 * ║ is a second place the ratio lives, and the failure mode is somebody       ║
 * ║ adding a 30-mark paper as 25 + 5 because it looked about right.           ║
 * ║                                                                           ║
 * ║ Migration 0056 enforces the same rule as a CHECK constraint on            ║
 * ║ paper_settings, in integer arithmetic, so a row that disagrees with this  ║
 * ║ module cannot exist. This is the readable copy; that one is the binding   ║
 * ║ one.                                                                      ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Every question is worth exactly one mark, so a paper's mark total and its
 * question count are the same number. That is why a blueprint needs only the
 * marks to be fully determined, and why there is no per-question marks field
 * anywhere in the bank.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** MCQ share of every paper. Not configurable — see the box above. */
export const MCQ_SHARE = 4 / 5

/** Short-answer share. Stated rather than computed so both read the same way. */
export const SHORT_ANSWER_SHARE = 1 / 5

/**
 * The sizes the product offers today.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ 50 WAS REMOVED ON 11 AUG 2026, AT THE OWNER'S INSTRUCTION.               │
 * │                                                                           │
 * │ It had been offered since 0056 and never once chosen — every paper ever   │
 * │ generated on this project is 20 marks, which is what made the removal     │
 * │ safe. Migration 0074 deletes the matching paper_settings row and REFUSES  │
 * │ to run if any 50-mark paper exists, so the two cannot disagree.           │
 * │                                                                           │
 * │ Nothing about the 80/20 rule changed: it is still derived below, and a    │
 * │ future size only has to be added back to this array. The box above still  │
 * │ describes the arithmetic for any multiple of five.                        │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export const PAPER_SIZES = [20] as const
export type PaperSize = (typeof PAPER_SIZES)[number]

export interface PaperBlueprint {
  marks: number
  mcqCount: number
  shortAnswerCount: number
}

/**
 * Is this a mark total the ratio can split into whole questions?
 *
 * 80/20 of anything not divisible by 5 lands on a fraction — 30 marks is 24+6
 * and fine, 22 marks is 17.6+4.4 and is not a paper. Checked before deriving
 * rather than rounding, because rounding silently produces a paper whose
 * ratio is not 80/20 while looking like it obeyed the rule.
 */
export function isValidPaperSize(marks: number): boolean {
  return Number.isInteger(marks) && marks > 0 && marks % 5 === 0
}

/**
 * The blueprint for a mark total.
 *
 * Throws rather than returning null for an invalid size: every caller reaches
 * here with a value that came from paper_settings, where a CHECK constraint
 * has already refused anything that cannot split. A size that fails here means
 * the database and this module disagree, which is not a condition a UI should
 * try to render its way around.
 */
export function blueprintFor(marks: number): PaperBlueprint {
  if (!isValidPaperSize(marks)) {
    throw new Error(
      `${marks} is not a usable paper size: the 80/20 split requires a multiple of 5.`,
    )
  }

  return {
    marks,
    mcqCount: (marks * 4) / 5,
    shortAnswerCount: marks / 5,
  }
}

/** How many questions of one type this blueprint needs. */
export function countFor(blueprint: PaperBlueprint, qtype: QuestionType): number {
  return qtype === 'mcq' ? blueprint.mcqCount : blueprint.shortAnswerCount
}

/**
 * Does a blueprint actually obey the rule?
 *
 * Used to validate a blueprint that arrived from the database rather than from
 * blueprintFor() — settings are editable, and this is the application-side
 * mirror of paper_settings' CHECK constraints. Both halves are asserted: the
 * counts must sum to the marks AND sit at 80/20, because a 20-mark paper of
 * 10 + 10 sums correctly and is not the product.
 */
export function isValidBlueprint(blueprint: PaperBlueprint): boolean {
  const { marks, mcqCount, shortAnswerCount } = blueprint

  if (!isValidPaperSize(marks)) return false
  if (mcqCount + shortAnswerCount !== marks) return false

  // Integer cross-multiplication rather than `mcqCount === marks * 0.8`, which
  // is exactly true for 20 and 50 and stops being exactly true elsewhere.
  return mcqCount * 5 === marks * 4 && shortAnswerCount * 5 === marks
}
