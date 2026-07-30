import { z } from 'zod'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Question metadata vocabularies — Bloom level and provenance.
 *
 * Sibling of status.ts, and for the same reason: every one of these had been
 * spelled out independently in more than one layer, and the copies disagreed.
 * `QuestionSource` in particular was a hand-written TypeScript union in
 * server/actions/questions.ts restating a Postgres CHECK — the exact shape of
 * the status bug that let 0037 ship four values the UI had never heard of.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Bloom's revised taxonomy, in cognitive order.
 *
 * Order is meaningful and matches the Postgres enum `bloom_taxonomy` (0037).
 * A distribution chart that sorted these alphabetically would put `analyze`
 * first and `understand` last, which is not a taxonomy, it is a word list.
 */
export const BLOOM_LEVELS = [
  'remember',
  'understand',
  'apply',
  'analyze',
  'evaluate',
  'create',
] as const

export type BloomLevel = (typeof BLOOM_LEVELS)[number]

export const bloomLevelSchema = z.enum(BLOOM_LEVELS)

/**
 * Where a question came from.
 *
 * Mirrors `check (source in ('manual','import','ai'))` on public.questions
 * (0009:80).
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ NOT THE SAME COLUMN AS question_translations.source.                      │
 * │                                                                           │
 * │ That one is `check (source in ('human','ai'))` (0009:203) and means who    │
 * │ wrote a TRANSLATION. Two columns, same name, different vocabularies, one  │
 * │ table apart. Anything reading "source" has to know which it has.          │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export const QUESTION_SOURCES = ['manual', 'import', 'ai'] as const

export type QuestionSourceValue = (typeof QUESTION_SOURCES)[number]

export const questionSourceSchema = z.enum(QUESTION_SOURCES)

/**
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ PROVENANCE IS NOT AN EDITABLE ATTRIBUTE.                                  │
 * │                                                                           │
 * │ `source` and `imported_from` record where a question CAME FROM. A chef    │
 * │ editing the wording of an imported question has not made it hand-written, │
 * │ and must not be able to say they did — otherwise the field records the    │
 * │ last person to touch it rather than its origin, and is worth nothing.     │
 * │                                                                           │
 * │ So the editor renders them read-only and saveQuestion() does not send     │
 * │ them at all. save_question() (0039) coalesces a missing p_source to the   │
 * │ stored value, which means provenance survives an edit BY CONSTRUCTION —   │
 * │ there is no code path through the editor that could overwrite it, rather  │
 * │ than a rule somebody has to remember not to break.                        │
 * │                                                                           │
 * │ The writers are the importer (M11) and the AI generator (M12), which set  │
 * │ it once at creation and never again.                                      │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export const PROVENANCE_IS_READ_ONLY = true
