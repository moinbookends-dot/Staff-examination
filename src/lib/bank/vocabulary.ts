import { z } from 'zod'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The examination bank's closed vocabularies, mirrored from migration 0053.
 *
 * Three enums exist in Postgres — bank_difficulty, bank_question_type and
 * bank_question_status — and these are their TypeScript counterparts.
 * tests/unit/bank-vocabulary.test.ts reads the migration and pins the two
 * copies against each other in BOTH directions, because a check in one
 * direction passes against an empty list.
 *
 * That test exists because of what happened to the last question bank: the
 * status vocabulary was written out independently in five layers and three of
 * them disagreed, so a question in `review` rendered the literal string
 * `questions.status.review` at a chef, and a question set to `approved` was
 * silently absent from every paper. One source per vocabulary, checked.
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────────────────────────────────────────────────────
// Difficulty
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ WHAT EASY, MEDIUM AND HARD MEAN IS NOT DECIDED HERE, AND MUST NOT BE.     ║
 * ║                                                                           ║
 * ║ This module knows that there are three levels and what they are called.   ║
 * ║ It knows NOTHING about which questions belong in which, and no code in    ║
 * ║ this repository does.                                                     ║
 * ║                                                                           ║
 * ║ Difficulty is assigned by an Editor, by hand, according to a separate     ║
 * ║ Difficulty Rules document that is the single source of truth for those    ║
 * ║ definitions. There is deliberately:                                       ║
 * ║                                                                           ║
 * ║   · no automatic classification                                           ║
 * ║   · no suggestion, hint or default level on the editor form               ║
 * ║   · no Bloom's Taxonomy, and no other educational framework               ║
 * ║   · no validation that a question "looks" like its level                  ║
 * ║   · no statistical difficulty inferred from anything                      ║
 * ║                                                                           ║
 * ║ The old bank had all of this — a 1-5 author estimate, an OBSERVED         ║
 * ║ difficulty band computed from attempt data, a `misrated` flag that        ║
 * ║ compared the two, and a bloom_level column. None of it survives, and none ║
 * ║ of it should be reintroduced under a new name.                            ║
 * ║                                                                           ║
 * ║ WHEN THE RULES DOCUMENT ARRIVES it becomes guidance shown to the Editor   ║
 * ║ beside the field — text they read while deciding. If it ever needs to be  ║
 * ║ more than that, that is a schema conversation, not a helper function      ║
 * ║ added quietly here.                                                       ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Declared easy → hard, matching the Postgres enum's declaration order so
 * `order by difficulty` in SQL and this array agree about what "ascending"
 * means. Postgres sorts an enum by declaration position, not alphabetically.
 */
export const DIFFICULTIES = ['easy', 'medium', 'hard'] as const
export type Difficulty = (typeof DIFFICULTIES)[number]
export const difficultySchema = z.enum(DIFFICULTIES)

// ─────────────────────────────────────────────────────────────────────────────
// Question type
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Two types, and there will not be a third.
 *
 * The paper blueprint is expressed as a count of each — 16 MCQ + 4 short for a
 * 20-mark paper — so a third type has nowhere to go in an 80/20 split. Adding
 * one is a change to what an exam IS, not a new enum value.
 */
export const QUESTION_TYPES = ['mcq', 'short_answer'] as const
export type QuestionType = (typeof QUESTION_TYPES)[number]
export const questionTypeSchema = z.enum(QUESTION_TYPES)

/** The four option slots an MCQ always has. Never three, never five. */
export const OPTION_KEYS = ['A', 'B', 'C', 'D'] as const
export type OptionKey = (typeof OPTION_KEYS)[number]
export const optionKeySchema = z.enum(OPTION_KEYS)

// ─────────────────────────────────────────────────────────────────────────────
// Status
// ─────────────────────────────────────────────────────────────────────────────

/**
 * draft    — being written; may be missing languages
 * active   — complete in all three languages, and drawable onto a paper
 * archived — withdrawn from the pool, still visible to Editors, restorable
 *
 * Deletion is NOT here. It is `deleted_at` on the row, because a deleted
 * question must still render on every paper that already contains it — and
 * exam_paper_questions references it ON DELETE RESTRICT, so the database
 * refuses any other reading.
 */
export const QUESTION_STATUSES = ['draft', 'active', 'archived'] as const
export type QuestionStatus = (typeof QUESTION_STATUSES)[number]
export const questionStatusSchema = z.enum(QUESTION_STATUSES)

/**
 * The one status a paper may be drawn from.
 *
 * A function rather than a bare constant so every caller reads the same
 * definition. The old bank learned this the hard way: its publish gate tested
 * the literal string 'active' while `question_pool()` drew on two statuses, so
 * a question could reach a live paper without ever passing validation.
 */
export function isDrawable(status: QuestionStatus): boolean {
  return status === 'active'
}

// ─────────────────────────────────────────────────────────────────────────────
// Locales
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Every question exists in all three, or it cannot be made active.
 *
 * This is a stricter list than the app's UI locales, and the two are not the
 * same thing: the UI could gain a fourth language tomorrow, whereas a fourth
 * question language means 6,000 translations. Migration 0054 enforces the
 * completeness rule with a trigger; this array is what the editor form and the
 * importer iterate over.
 *
 * ENGLISH IS FIRST, and one thing depends on it: the duplicate-refusal index
 * in 0054 is scoped to the English text, because English is the language every
 * question is authored and imported in.
 */
export const BANK_LOCALES = ['en', 'hi', 'gu'] as const
export type BankLocale = (typeof BANK_LOCALES)[number]
export const bankLocaleSchema = z.enum(BANK_LOCALES)

/** Each language named in itself — never translated. */
export const BANK_LOCALE_LABELS: Record<BankLocale, string> = {
  en: 'English',
  hi: 'हिन्दी',
  gu: 'ગુજરાતી',
}

// ─────────────────────────────────────────────────────────────────────────────
// Limits, mirrored from the column constraints in 0054
// ─────────────────────────────────────────────────────────────────────────────

/**
 * These are the CHECK constraints, restated so a form can report them as field
 * errors instead of letting a 23514 reach a person as a database code.
 *
 * They are mirrors, not the source. If one of these disagrees with 0054 the
 * database wins and the user sees the raw error — which is the failure mode
 * the parity test in tests/unit/bank-vocabulary.test.ts exists to catch.
 */
export const QUESTION_MIN_LENGTH = 3
export const QUESTION_MAX_LENGTH = 2000

/** "Around two lines." 0054 caps answer_text at this, in the database. */
export const ANSWER_MAX_LENGTH = 400

export const TOPIC_MAX_LENGTH = 80
