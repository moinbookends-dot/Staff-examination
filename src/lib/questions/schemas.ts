import { z } from 'zod'

/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  THE QUESTION CONTRACT — single source of truth.                          ║
 * ║                                                                           ║
 * ║  Editors, renderers, graders, server actions, and the Postgres CHECK       ║
 * ║  constraint all derive from what is defined here. Change a shape in this   ║
 * ║  file and TypeScript will point at every place that needs updating.       ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * THREE SEPARATE SHAPES PER FORMAT, and the separation is load-bearing:
 *
 *   QuestionContent — what the CANDIDATE may see. Stem, options, items.
 *                     Contains NO correct answers.
 *
 *   AnswerKey       — correct answers and grading configuration. Stored in a
 *                     different table (question_answer_keys) with its own RLS,
 *                     and never sent to a candidate's browser.
 *
 *   AnswerPayload   — what the candidate submits back.
 *
 * WHY CONTENT AND KEY ARE SPLIT (plan §4.3): if the correct answer sits in the
 * same row the exam page fetches, a candidate opens devtools and reads it. RLS
 * is row-level and cannot hide a column, so the only reliable fix is to keep
 * the key in a separate table and serve papers through a server route that
 * never selects it.
 *
 * FOURTEEN TYPES, NINE FORMATS: the PRD lists 14 question types, but
 * Image/Video/Audio/Document-Based describe the STIMULUS, not the answer.
 * An image-based question is still an MCQ or still a short answer. Media
 * attaches to any format via question_media, so there are nine answer shapes
 * here, not fourteen.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Shared pieces
// ─────────────────────────────────────────────────────────────────────────────

/** Stable within a question; answers reference these ids, never array indices. */
export const optionIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/, 'Option ids must be alphanumeric, dash or underscore.')

export const choiceSchema = z.object({
  id: optionIdSchema,
  text: z.string().trim().min(1, 'Every option needs text.').max(1000),
  /** References question_media.id — lets an option itself be an image. */
  mediaId: z.string().uuid().optional(),
})
export type Choice = z.infer<typeof choiceSchema>

export const rubricCriterionSchema = z.object({
  id: optionIdSchema,
  label: z.string().trim().min(1).max(300),
  max: z.number().positive().max(1000),
  /** Shown to the evaluator: what earns full marks. */
  descriptor: z.string().max(2000).optional(),
})
export type RubricCriterion = z.infer<typeof rubricCriterionSchema>

/**
 * How a typed answer is compared to the accepted list.
 *   exact  — byte-for-byte
 *   ci     — case- and whitespace-insensitive. The sane default.
 *   fuzzy  — edit distance within `tolerance`. Flags needs_review rather than
 *            auto-failing, because with four languages in play a near-miss is
 *            far more likely to be a spelling variant than a wrong answer.
 *   regex  — for structured answers (temperatures, codes)
 */
export const matchModeSchema = z.enum(['exact', 'ci', 'fuzzy', 'regex'])
export type MatchMode = z.infer<typeof matchModeSchema>

export const RESPONSE_FORMATS = [
  'choice_single',
  'choice_multi',
  'boolean',
  'blanks',
  'pairs',
  'order',
  'text_short',
  'text_long',
  'evaluator_only',
] as const
export const responseFormatSchema = z.enum(RESPONSE_FORMATS)
export type ResponseFormat = z.infer<typeof responseFormatSchema>

/** All 14 PRD-facing types. Presentation label; grading follows the format. */
export const QUESTION_TYPES = [
  'mcq_single', 'mcq_multi', 'true_false', 'fill_blank', 'match', 'sequence',
  'short_answer', 'essay', 'image', 'video', 'audio', 'document',
  'practical', 'viva',
] as const
export const questionTypeSchema = z.enum(QUESTION_TYPES)
export type QuestionType = z.infer<typeof questionTypeSchema>

/**
 * Which formats each type may use. Mirrors the q_format_matches_type CHECK
 * constraint in the database — the two must agree or a question valid in the
 * UI is rejected on insert.
 *
 * The four media types accept ANY format, which is the whole point of the
 * split: an image-based question can be multiple choice, a short answer, or
 * anything else.
 */
export const TYPE_FORMATS: Record<QuestionType, readonly ResponseFormat[]> = {
  mcq_single: ['choice_single'],
  mcq_multi: ['choice_multi'],
  true_false: ['boolean'],
  fill_blank: ['blanks'],
  match: ['pairs'],
  sequence: ['order'],
  short_answer: ['text_short'],
  essay: ['text_long'],
  practical: ['evaluator_only'],
  viva: ['evaluator_only'],
  image: RESPONSE_FORMATS,
  video: RESPONSE_FORMATS,
  audio: RESPONSE_FORMATS,
  document: RESPONSE_FORMATS,
}

// ─────────────────────────────────────────────────────────────────────────────
// QuestionContent — candidate-visible. NO ANSWERS.
// ─────────────────────────────────────────────────────────────────────────────

const uniqueIds = <T extends { id: string }>(items: T[]) =>
  new Set(items.map((i) => i.id)).size === items.length

export const questionContentSchema = z.discriminatedUnion('format', [
  z.object({
    format: z.literal('choice_single'),
    choices: z
      .array(choiceSchema)
      .min(2, 'Give at least two options.')
      .max(6, 'Six options is the practical maximum.')
      .refine(uniqueIds, 'Option ids must be unique.'),
  }),

  z.object({
    format: z.literal('choice_multi'),
    choices: z
      .array(choiceSchema)
      .min(2, 'Give at least two options.')
      .max(8)
      .refine(uniqueIds, 'Option ids must be unique.'),
  }),

  // True/False needs no payload — the two options are implied. Keeping it in
  // the union rather than special-casing means every consumer handles it the
  // same way as the rest.
  z.object({
    format: z.literal('boolean'),
  }),

  z.object({
    format: z.literal('blanks'),
    /** Prose with {{blank_id}} placeholders, e.g. "Sear at {{temp}}°C". */
    template: z.string().trim().min(1).max(4000),
    blanks: z
      .array(z.object({ id: optionIdSchema, label: z.string().max(120).optional() }))
      .min(1, 'Add at least one blank.')
      .max(20)
      .refine(uniqueIds, 'Blank ids must be unique.'),
  }),

  z.object({
    format: z.literal('pairs'),
    left: z.array(choiceSchema).min(2).max(10).refine(uniqueIds, 'Left ids must be unique.'),
    right: z.array(choiceSchema).min(2).max(12).refine(uniqueIds, 'Right ids must be unique.'),
    /**
     * Right-hand items with no match. Distractors make matching a real test
     * rather than a process of elimination that solves the last pair for free.
     */
    hasDistractors: z.boolean().default(false),
  }),

  z.object({
    format: z.literal('order'),
    items: z.array(choiceSchema).min(2).max(12).refine(uniqueIds, 'Item ids must be unique.'),
  }),

  z.object({
    format: z.literal('text_short'),
    maxChars: z.number().int().min(10).max(2000).default(300),
  }),

  z.object({
    format: z.literal('text_long'),
    maxWords: z.number().int().min(20).max(2000).default(500),
  }),

  z.object({
    format: z.literal('evaluator_only'),
    /** Shown to the assessor conducting the practical or viva. */
    instructions: z.string().max(4000).optional(),
  }),
])

export type QuestionContent = z.infer<typeof questionContentSchema>

/**
 * DRAFT content — structure only, completeness not required.
 *
 * The strict schema above gates PUBLISHING (status = 'active'). It is the wrong
 * thing to validate against while someone is typing: a fresh MCQ starts with
 * two options whose text is empty, which is invalid-but-expected. Validating
 * strictly during editing means the form opens covered in errors before the
 * chef has entered anything, which trains people to ignore validation.
 *
 * So: draft parsing checks that the SHAPE is right (correct discriminant,
 * arrays are arrays, ids well-formed) while allowing blank text and short
 * collections. Autosave and status='draft' use this; activation uses the strict
 * schema plus validateQuestion().
 *
 * The database CHECK is deliberately aligned with the draft rules, not the
 * strict ones, so a half-finished question can be saved and returned to.
 */
const draftChoiceSchema = z.object({
  id: optionIdSchema,
  text: z.string().max(1000),          // may be empty while drafting
  mediaId: z.string().uuid().optional(),
})

export const questionContentDraftSchema = z.discriminatedUnion('format', [
  z.object({ format: z.literal('choice_single'), choices: z.array(draftChoiceSchema).max(6) }),
  z.object({ format: z.literal('choice_multi'), choices: z.array(draftChoiceSchema).max(8) }),
  z.object({ format: z.literal('boolean') }),
  z.object({
    format: z.literal('blanks'),
    template: z.string().max(4000),
    blanks: z.array(z.object({ id: optionIdSchema, label: z.string().max(120).optional() })).max(20),
  }),
  z.object({
    format: z.literal('pairs'),
    left: z.array(draftChoiceSchema).max(10),
    right: z.array(draftChoiceSchema).max(12),
    hasDistractors: z.boolean().default(false),
  }),
  z.object({ format: z.literal('order'), items: z.array(draftChoiceSchema).max(12) }),
  z.object({ format: z.literal('text_short'), maxChars: z.number().int().min(10).max(2000).default(300) }),
  z.object({ format: z.literal('text_long'), maxWords: z.number().int().min(20).max(2000).default(500) }),
  z.object({ format: z.literal('evaluator_only'), instructions: z.string().max(4000).optional() }),
])

export type QuestionContentDraft = z.infer<typeof questionContentDraftSchema>

// ─────────────────────────────────────────────────────────────────────────────
// AnswerKey — separate table, chef/admin only, never sent to a candidate.
// ─────────────────────────────────────────────────────────────────────────────

export const answerKeySchema = z.discriminatedUnion('format', [
  z.object({
    format: z.literal('choice_single'),
    correct: optionIdSchema,
  }),

  z.object({
    format: z.literal('choice_multi'),
    correct: z.array(optionIdSchema).min(1, 'Mark at least one option correct.'),
    /**
     * Partial credit: proportion of correct selections minus incorrect ones,
     * floored at zero. Without it, multi-select is brutally all-or-nothing and
     * scores stop reflecting partial knowledge.
     */
    partialCredit: z.boolean().default(true),
  }),

  z.object({
    format: z.literal('boolean'),
    correct: z.boolean(),
  }),

  z.object({
    format: z.literal('blanks'),
    blanks: z
      .array(
        z.object({
          id: optionIdSchema,
          accept: z.array(z.string().min(1)).min(1, 'Give at least one accepted answer.'),
          match: matchModeSchema.default('ci'),
          /** Edit distance for fuzzy. 1–2 catches typos without accepting a different word. */
          tolerance: z.number().int().min(1).max(5).optional(),
        }),
      )
      .min(1),
    partialCredit: z.boolean().default(true),
  }),

  z.object({
    format: z.literal('pairs'),
    /** left id → right id. */
    correct: z.record(optionIdSchema, optionIdSchema),
    partialCredit: z.boolean().default(true),
  }),

  z.object({
    format: z.literal('order'),
    correct: z.array(optionIdSchema).min(2),
    /**
     * exact    — all-or-nothing
     * adjacent — credit per correctly-ordered adjacent pair. Good for recipes:
     *            getting steps 1–2 right is worth something even if 5 and 6 swap.
     * kendall  — rank correlation across the whole sequence
     */
    scoring: z.enum(['exact', 'adjacent', 'kendall']).default('exact'),
  }),

  z.object({
    format: z.literal('text_short'),
    modelAnswer: z.string().max(2000).optional(),
    /** Surfaced to the evaluator as hints. Never auto-scored — see grading.ts. */
    keywords: z.array(z.string().min(1)).default([]),
  }),

  z.object({
    format: z.literal('text_long'),
    modelAnswer: z.string().max(8000).optional(),
    rubric: z.array(rubricCriterionSchema).default([]),
  }),

  z.object({
    format: z.literal('evaluator_only'),
    rubric: z.array(rubricCriterionSchema).min(1, 'A practical needs at least one rubric criterion.'),
  }),
])

export type AnswerKey = z.infer<typeof answerKeySchema>

// ─────────────────────────────────────────────────────────────────────────────
// AnswerPayload — what the candidate submits.
// ─────────────────────────────────────────────────────────────────────────────

export const answerPayloadSchema = z.discriminatedUnion('format', [
  z.object({ format: z.literal('choice_single'), choice: optionIdSchema.nullable() }),
  z.object({ format: z.literal('choice_multi'), choices: z.array(optionIdSchema) }),
  z.object({ format: z.literal('boolean'), value: z.boolean().nullable() }),
  z.object({ format: z.literal('blanks'), values: z.record(optionIdSchema, z.string()) }),
  z.object({ format: z.literal('pairs'), mapping: z.record(optionIdSchema, optionIdSchema) }),
  z.object({ format: z.literal('order'), order: z.array(optionIdSchema) }),
  z.object({ format: z.literal('text_short'), text: z.string() }),
  z.object({ format: z.literal('text_long'), text: z.string() }),
  z.object({
    format: z.literal('evaluator_only'),
    note: z.string().max(4000).optional(),
    attachments: z.array(z.string()).default([]),
  }),
])

export type AnswerPayload = z.infer<typeof answerPayloadSchema>

// ─────────────────────────────────────────────────────────────────────────────
// Cross-shape validation
// ─────────────────────────────────────────────────────────────────────────────

export interface ValidationIssue {
  path: string
  message: string
}

/**
 * Validates content and key TOGETHER.
 *
 * Neither schema alone can catch the mistakes that matter most, because the
 * correct answers live in a different object from the options they reference.
 * A key naming a choice id that does not exist parses perfectly and then marks
 * every candidate wrong — silently, with no error anywhere.
 *
 * Call this at every write boundary. The database CHECK constraint enforces
 * structural invariants as a backstop, but cannot see across the two tables.
 */
export function validateQuestion(
  content: QuestionContent,
  key: AnswerKey,
): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  if (content.format !== key.format) {
    return [{ path: 'format', message: `Content is ${content.format} but the answer key is ${key.format}.` }]
  }

  switch (content.format) {
    case 'choice_single': {
      const k = key as Extract<AnswerKey, { format: 'choice_single' }>
      const ids = content.choices.map((c) => c.id)
      if (!ids.includes(k.correct)) {
        issues.push({ path: 'correct', message: `Correct answer "${k.correct}" is not one of the options.` })
      }
      break
    }

    case 'choice_multi': {
      const k = key as Extract<AnswerKey, { format: 'choice_multi' }>
      const ids = new Set(content.choices.map((c) => c.id))
      for (const id of k.correct) {
        if (!ids.has(id)) issues.push({ path: 'correct', message: `Correct answer "${id}" is not one of the options.` })
      }
      if (k.correct.length === content.choices.length) {
        issues.push({ path: 'correct', message: 'Every option is marked correct — the question cannot discriminate.' })
      }
      break
    }

    case 'blanks': {
      const k = key as Extract<AnswerKey, { format: 'blanks' }>
      const contentIds = new Set(content.blanks.map((b) => b.id))
      const keyIds = new Set(k.blanks.map((b) => b.id))

      for (const id of contentIds) {
        if (!keyIds.has(id)) issues.push({ path: 'blanks', message: `Blank "${id}" has no accepted answers.` })
      }
      for (const id of keyIds) {
        if (!contentIds.has(id)) issues.push({ path: 'blanks', message: `Answer key references unknown blank "${id}".` })
      }
      // Every blank must actually appear in the template, or the candidate is
      // never shown an input for it and cannot possibly answer.
      for (const b of content.blanks) {
        if (!content.template.includes(`{{${b.id}}}`)) {
          issues.push({ path: 'template', message: `Blank "${b.id}" does not appear in the text.` })
        }
      }
      for (const b of k.blanks) {
        if (b.match === 'fuzzy' && b.tolerance === undefined) {
          issues.push({ path: 'blanks', message: `Blank "${b.id}" uses fuzzy matching but sets no tolerance.` })
        }
        if (b.match === 'regex') {
          for (const pattern of b.accept) {
            try {
              new RegExp(pattern)
            } catch {
              issues.push({ path: 'blanks', message: `Blank "${b.id}" has an invalid regular expression.` })
            }
          }
        }
      }
      break
    }

    case 'pairs': {
      const k = key as Extract<AnswerKey, { format: 'pairs' }>
      const leftIds = new Set(content.left.map((c) => c.id))
      const rightIds = new Set(content.right.map((c) => c.id))

      for (const l of leftIds) {
        if (!(l in k.correct)) issues.push({ path: 'correct', message: `Left item "${l}" has no match.` })
      }
      for (const [l, r] of Object.entries(k.correct)) {
        if (!leftIds.has(l)) issues.push({ path: 'correct', message: `Answer key references unknown left item "${l}".` })
        if (!rightIds.has(r)) issues.push({ path: 'correct', message: `Answer key references unknown right item "${r}".` })
      }
      if (!content.hasDistractors && content.right.length !== content.left.length) {
        issues.push({
          path: 'right',
          message: 'Column sizes differ. Enable distractors, or make them equal.',
        })
      }
      break
    }

    case 'order': {
      const k = key as Extract<AnswerKey, { format: 'order' }>
      const itemIds = content.items.map((i) => i.id)
      if (k.correct.length !== itemIds.length) {
        issues.push({ path: 'correct', message: 'The correct order must list every item exactly once.' })
      }
      for (const id of k.correct) {
        if (!itemIds.includes(id)) issues.push({ path: 'correct', message: `Correct order references unknown item "${id}".` })
      }
      if (new Set(k.correct).size !== k.correct.length) {
        issues.push({ path: 'correct', message: 'The correct order repeats an item.' })
      }
      break
    }

    case 'text_long': {
      const k = key as Extract<AnswerKey, { format: 'text_long' }>
      if (k.rubric.length && !uniqueIds(k.rubric)) {
        issues.push({ path: 'rubric', message: 'Rubric criterion ids must be unique.' })
      }
      break
    }

    case 'evaluator_only': {
      const k = key as Extract<AnswerKey, { format: 'evaluator_only' }>
      if (!uniqueIds(k.rubric)) {
        issues.push({ path: 'rubric', message: 'Rubric criterion ids must be unique.' })
      }
      break
    }

    // boolean and text_short have no cross-shape invariants.
    default:
      break
  }

  return issues
}

/** Is this format machine-gradable at all? Drives requires_manual_grading. */
export function isAutoGradable(format: ResponseFormat): boolean {
  return !['text_short', 'text_long', 'evaluator_only'].includes(format)
}

export function formatAllowedForType(type: QuestionType, format: ResponseFormat): boolean {
  return TYPE_FORMATS[type].includes(format)
}
