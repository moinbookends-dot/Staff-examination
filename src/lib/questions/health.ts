/**
 * What is missing from a question's record.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THIS IS COMPLETENESS, NOT QUALITY, AND THE DISTINCTION IS THE POINT.      │
 * │                                                                           │
 * │ publishIssues (./publish) is the only thing that decides whether a        │
 * │ question is fit to be graded against, and nothing here calls it or        │
 * │ reproduces any part of it. It answers "may this go live". This answers a  │
 * │ different question — "what has nobody filled in yet" — over fields that   │
 * │ are already on the row.                                                   │
 * │                                                                           │
 * │ Keeping them apart is what stops this from becoming a second publish gate │
 * │ that drifts from the first. A flag here never blocks anything; it is a    │
 * │ badge in a table.                                                         │
 * │                                                                           │
 * │ M9's statistical signals — misrated difficulty, poor discrimination —     │
 * │ extend this function rather than replacing it. They need question_stats(),│
 * │ which is the most expensive read in the codebase, so they are not here    │
 * │ yet and nothing in the bank's list query is allowed to call it.           │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHAT IS DELIBERATELY NOT A FLAG: "never used".                            │
 * │                                                                           │
 * │ usage_count has exactly one writer — publish_exam, and only for FIXED     │
 * │ papers, where it joins through exam_questions (0014_exams.sql:703).       │
 * │ Rule-based exams draw at attempt start and never touch it.                │
 * │                                                                           │
 * │ This bank is built around rule-based selection, so a company delivering   │
 * │ every exam by rules has usage_count = 0 on every question in it. A        │
 * │ "never used" badge would fire on the whole bank and mean nothing, and a   │
 * │ badge that is always on is worse than no badge — it teaches people to     │
 * │ ignore the column the real flags live in.                                 │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

export const QUESTION_HEALTH_FLAGS = [
  'no-answer-key',
  'no-category',
  'no-bloom',
  'untranslated',
] as const

export type QuestionHealthFlag = (typeof QUESTION_HEALTH_FLAGS)[number]

export interface QuestionHealth {
  flag: QuestionHealthFlag
  /** For `untranslated`, the locales with no published translation. */
  detail?: string[]
}

/** Just the fields the rule reads. Keeps this callable from a test fixture. */
export interface QuestionHealthInput {
  category_id: string | null
  bloom_level: string | null
  /** Whether a question_answer_keys row exists. Supplied by the caller's read. */
  hasAnswerKey: boolean
  /** Locales with a PUBLISHED translation. A draft translation is not delivered. */
  translatedLocales: readonly string[]
}

/**
 * The locales a question is expected to exist in.
 *
 * 'en' is excluded because the base row IS the English one — `questions.stem`
 * is not a translation of anything, and asking for an `en` row in
 * question_translations would flag every question in the bank.
 */
export const EXPECTED_TRANSLATION_LOCALES = ['hi', 'gu'] as const

export function questionHealth(input: QuestionHealthInput): QuestionHealth[] {
  const flags: QuestionHealth[] = []

  // Ordered by consequence, not alphabetically: the list is rendered in this
  // order and the first badge is the one people read.

  if (!input.hasAnswerKey) {
    // Only reachable for a question written outside save_question — an import,
    // a seed, psql. bulkPublishQuestions already refuses to publish one, on the
    // grounds that live it would grade every candidate at zero. Surfacing it in
    // the bank means somebody finds out before they try.
    flags.push({ flag: 'no-answer-key' })
  }

  if (!input.category_id) {
    // Not tidiness. draw_paper selects by category, so an uncategorised
    // question can never be drawn by a rule — it is dead stock that looks
    // perfectly healthy in every other column.
    flags.push({ flag: 'no-category' })
  }

  if (!input.bloom_level) {
    flags.push({ flag: 'no-bloom' })
  }

  const translated = new Set(input.translatedLocales)
  const missing = EXPECTED_TRANSLATION_LOCALES.filter((locale) => !translated.has(locale))
  if (missing.length > 0) {
    flags.push({ flag: 'untranslated', detail: missing })
  }

  return flags
}
