import { z } from 'zod'
import { dbId } from '@/lib/db/id'
import {
  ANSWER_MAX_LENGTH,
  BANK_LOCALES,
  QUESTION_MAX_LENGTH,
  QUESTION_MIN_LENGTH,
  bankLocaleSchema,
  difficultySchema,
  optionKeySchema,
  questionStatusSchema,
  questionTypeSchema,
  type BankLocale,
} from './vocabulary'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Validation for writing a question.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THESE MIRROR MIGRATION 0054. THE DATABASE IS THE AUTHORITY.               │
 * │                                                                           │
 * │ Every rule below also exists as a CHECK constraint or a trigger, and it   │
 * │ has to: the importer, a seed script and psql all bypass this file, and    │
 * │ 6,000 rows arriving from a spreadsheet is exactly where a malformed       │
 * │ question gets in. 0009 made the same argument for                          │
 * │ validate_question_content() and it was right.                             │
 * │                                                                           │
 * │ So what is this for? MESSAGES. A CHECK constraint failing produces        │
 * │ `new row violates check constraint "bank_question_texts_shape"`, which    │
 * │ tells an Editor nothing about which of four option boxes they left blank. │
 * │ These schemas turn the same rules into a field error next to the field.   │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */

// ─────────────────────────────────────────────────────────────────────────────
// One language of one question
// ─────────────────────────────────────────────────────────────────────────────

const questionText = z
  .string()
  .trim()
  .min(QUESTION_MIN_LENGTH, 'Write the question.')
  .max(QUESTION_MAX_LENGTH, `Keep the question under ${QUESTION_MAX_LENGTH} characters.`)

const optionText = z.string().trim().min(1, 'Fill in every option.').max(500)

const answerText = z
  .string()
  .trim()
  .min(1, 'Write the answer.')
  // The two-line rule, as a character count. Stated in the message rather than
  // left as a bare number, because "400" means nothing to somebody who has
  // just been stopped by it.
  .max(ANSWER_MAX_LENGTH, `Keep the answer to about two lines (${ANSWER_MAX_LENGTH} characters).`)

/**
 * A blank language is not an error — it is a draft.
 *
 * The editor form holds three tabs and an Editor may legitimately write the
 * English, save, and come back to the Hindi tomorrow. So every field here is
 * optional at this level, and completeness is decided ONCE, at the point where
 * it actually matters: promoting the question to `active`. See
 * questionInputSchema below.
 *
 * Getting this wrong in the obvious direction — requiring all three always —
 * would make it impossible to save a partially written question at all, which
 * is the normal state of a question for as long as it takes to translate it.
 */
export const questionTextInputSchema = z.object({
  question: z.string().trim().max(QUESTION_MAX_LENGTH).optional(),
  optionA: z.string().trim().max(500).optional(),
  optionB: z.string().trim().max(500).optional(),
  optionC: z.string().trim().max(500).optional(),
  optionD: z.string().trim().max(500).optional(),
  answerText: z.string().trim().max(ANSWER_MAX_LENGTH).optional(),
})

export type QuestionTextInput = z.infer<typeof questionTextInputSchema>

/**
 * The strict shape of ONE fully-written language, per question type.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHY THIS EXISTS BESIDE THE LENIENT SCHEMA ABOVE.                          │
 * │                                                                           │
 * │ isLocaleComplete() answers yes or no, which is all the editor form needs  │
 * │ to grey out a tab. The IMPORTER needs more than that: a spreadsheet row   │
 * │ that fails has to be reported to the person who wrote it with the reason  │
 * │ attached — "row 412: Gujarati option C is empty" — because they are about │
 * │ to fix 6,000 of these and "invalid" is not actionable.                    │
 * │                                                                           │
 * │ Same rules, same constants, two outputs. The boolean is derived from      │
 * │ these rather than restated, so the two cannot drift into disagreeing      │
 * │ about what "complete" means.                                              │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export const completeMcqTextSchema = z.object({
  question: questionText,
  optionA: optionText,
  optionB: optionText,
  optionC: optionText,
  optionD: optionText,
})

export const completeShortAnswerTextSchema = z.object({
  question: questionText,
  answerText,
})

export function completeTextSchemaFor(qtype: 'mcq' | 'short_answer') {
  return qtype === 'mcq' ? completeMcqTextSchema : completeShortAnswerTextSchema
}

/**
 * Why this language is not finished — one message per problem, or [] if it is.
 *
 * Used by the import preview. The editor form uses isLocaleComplete() below,
 * which is this function asking only whether the list came back empty.
 */
export function localeTextIssues(
  text: QuestionTextInput | undefined,
  qtype: 'mcq' | 'short_answer',
): string[] {
  const result = completeTextSchemaFor(qtype).safeParse(text ?? {})
  if (result.success) return []

  return result.error.issues.map((issue) => {
    const field = issue.path[0]
    return field ? `${FIELD_LABEL[String(field)] ?? String(field)}: ${issue.message}` : issue.message
  })
}

/** Field names as a person filling a spreadsheet would recognise them. */
const FIELD_LABEL: Record<string, string> = {
  question: 'Question',
  optionA: 'Option A',
  optionB: 'Option B',
  optionC: 'Option C',
  optionD: 'Option D',
  answerText: 'Answer',
}

// ─────────────────────────────────────────────────────────────────────────────
// Completeness
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Is this one language fully written, for this question type?
 *
 * Exported because three separate places need the same answer and must not
 * each decide it: the editor form (to enable Publish and to mark the tabs),
 * the importer (to decide whether a row can go straight to active), and the
 * server action (to refuse a promotion before the database has to).
 *
 * A trailing-space-only option counts as blank — that is what a half-filled
 * spreadsheet cell actually contains, and `.trim()` above has already reduced
 * it to ''.
 */
export function isLocaleComplete(
  text: QuestionTextInput | undefined,
  qtype: 'mcq' | 'short_answer',
): boolean {
  // Derived from localeTextIssues rather than restating its rules. Two
  // implementations of "complete" is how a form enables Publish for a question
  // the importer would reject, and neither side looks wrong on its own.
  return localeTextIssues(text, qtype).length === 0
}

/**
 * Which REQUIRED languages are still missing something.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ `required` IS A PARAMETER, NOT A CONSTANT, AND MIRRORS                    │
 * │ exam_settings.required_locales.                                           │
 * │                                                                           │
 * │ The bank is authored in English and translated later, so today the        │
 * │ required set is {en} and a question with only English is publishable.     │
 * │ When the translations land the setting becomes {en,hi,gu} and the same    │
 * │ code starts demanding all three — in the form, in the importer and in     │
 * │ the database trigger, which all read the one setting.                     │
 * │                                                                           │
 * │ Defaulting to BANK_LOCALES here would be the dangerous direction: it      │
 * │ would silently require three languages in any call site that forgot to    │
 * │ pass the setting, making every question unpublishable with no error       │
 * │ pointing at the cause. Defaulting to {en} is the recoverable one.         │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Ordered as BANK_LOCALES is, so messages read "Hindi, Gujarati" rather than
 * in whatever order the setting happens to store.
 */
export function incompleteLocales(
  texts: Partial<Record<BankLocale, QuestionTextInput>>,
  qtype: 'mcq' | 'short_answer',
  required: readonly BankLocale[] = ['en'],
): BankLocale[] {
  return BANK_LOCALES.filter((l) => required.includes(l) && !isLocaleComplete(texts[l], qtype))
}

// ─────────────────────────────────────────────────────────────────────────────
// The whole question
// ─────────────────────────────────────────────────────────────────────────────

const baseQuestionSchema = z.object({
  // dbId(), never z.string().uuid(). Zod 4 enforces RFC 4122 where Postgres
  // enforces nothing, and every seeded id in this project looks like
  // 00000000-0000-0000-0000-00000000c001 — which Postgres stores happily and
  // z.uuid() rejects. That mismatch has already broken one upload path here.
  brandId: dbId(),
  topicId: dbId().nullable().optional(),

  // No default. A default difficulty is a guess about which level a question
  // belongs to, and this system does not make that guess — see the box in
  // vocabulary.ts. The Editor chooses, or the form does not submit.
  difficulty: difficultySchema,

  status: questionStatusSchema.default('draft'),

  referenceDocumentId: dbId().nullable().optional(),
  referencePage: z.coerce
    .number()
    .int()
    .min(1, 'Page numbers start at 1.')
    .max(10_000)
    .nullable()
    .optional(),

  texts: z.object({
    en: questionTextInputSchema.optional(),
    hi: questionTextInputSchema.optional(),
    gu: questionTextInputSchema.optional(),
  }),
})

/**
 * MCQ and short answer, as a discriminated union — built per required-locale
 * set.
 *
 * The discriminator carries the one field that differs: an MCQ has a correct
 * option, a short answer does not. Expressing it as a union rather than an
 * optional field means TypeScript refuses `correctOption` on a short answer at
 * COMPILE time, which is the same guarantee 0054's
 * bank_q_correct_option_matches_type gives at run time.
 *
 * A factory, because the activation gate depends on a per-company setting.
 *
 * A module-level schema would have to bake in which languages are required,
 * and that is exam_settings.required_locales — a value the server reads per
 * request. Callers build the schema with the set they were given; the exported
 * `questionInputSchema` below is the English-only default for tests and for
 * anything parsing a draft, where the gate does not fire at all.
 */
export function makeQuestionInputSchema(required: readonly BankLocale[] = ['en']) {
  return buildQuestionInputSchema(required)
}

function buildQuestionInputSchema(required: readonly BankLocale[]) {
  return z
  .discriminatedUnion('qtype', [
    baseQuestionSchema.extend({
      qtype: z.literal('mcq'),
      correctOption: optionKeySchema,
    }),
    baseQuestionSchema.extend({
      qtype: z.literal('short_answer'),
      // Present and always null, rather than absent. A form posting a stale
      // correctOption after the Editor switched the type would otherwise pass
      // silently and be dropped; this makes the intent explicit at the schema.
      correctOption: z.null().optional(),
    }),
  ])
  /*
   * ┌─────────────────────────────────────────────────────────────────────────┐
   * │ THE COMPLETENESS GATE, AND WHY IT IS A REFINE RATHER THAN A FIELD RULE. │
   * │                                                                         │
   * │ "Written in every required language" is not a property of any single    │
   * │ field — it is a property of the whole question, and only when the       │
   * │ status being asked for is 'active'. A draft may be missing everything.  │
   * │                                                                         │
   * │ Migration 0054 enforces this with a trigger and will refuse the write   │
   * │ regardless. This exists so the Editor is told WHICH languages are       │
   * │ missing, on the form, instead of receiving the trigger's message.       │
   * └─────────────────────────────────────────────────────────────────────────┘
   */
  .superRefine((value, ctx) => {
    if (value.status !== 'active') return

    const missing = incompleteLocales(value.texts, value.qtype, required)
    if (missing.length === 0) return

    ctx.addIssue({
      code: 'custom',
      path: ['status'],
      message:
        `A question can only be made active once it is written in every required language. ` +
        `Still to do: ${missing.map((l) => LOCALE_NAME[l]).join(', ')}.`,
    })
  })
  /*
   * A page number with no document is a citation of nothing — 0054's
   * bank_q_page_needs_document. The reverse is fine and deliberately not
   * flagged: "it is in the Capiche manual somewhere" is a legitimate
   * half-answer while an Editor is still looking for the page.
   */
  .superRefine((value, ctx) => {
    if (value.referencePage != null && !value.referenceDocumentId) {
      ctx.addIssue({
        code: 'custom',
        path: ['referencePage'],
        message: 'Choose the document this page number is in.',
      })
    }
  })
}

/**
 * The English-only default.
 *
 * Correct for parsing a draft — where the activation gate never fires — and
 * for tests. A server action promoting a question to `active` must build its
 * own with makeQuestionInputSchema(settings.requiredLocales) rather than reach
 * for this one, or it will accept a question the database then refuses.
 */
export const questionInputSchema = makeQuestionInputSchema(['en'])

export type QuestionInput = z.infer<typeof questionInputSchema>

/** English names, for error messages. The native labels are for the UI. */
const LOCALE_NAME: Record<BankLocale, string> = {
  en: 'English',
  hi: 'Hindi',
  gu: 'Gujarati',
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading and filtering the bank
// ─────────────────────────────────────────────────────────────────────────────

export const BANK_PAGE_SIZES = [25, 50, 100] as const
export const DEFAULT_BANK_PAGE_SIZE = 25

/**
 * The Question Bank screen's URL state.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ EVERY FIELD IS OPTIONAL AND THE WHOLE THING IS CATCH-ALL PARSED.          │
 * │                                                                           │
 * │ These arrive from URLs people edit, bookmark, truncate and send to each   │
 * │ other. The old bank had a real bug here worth not repeating: both the     │
 * │ page and the action did `safeParse(raw).success ? data : { page: 1 }`, so │
 * │ a bookmarked search with ONE unrecognised value came back as the          │
 * │ unfiltered first page — silently, to somebody who believed they were      │
 * │ reading a filtered list.                                                  │
 * │                                                                           │
 * │ Here every field independently falls back, so one bad value costs that    │
 * │ one filter and nothing else. parseBankFilters() below is the only         │
 * │ entry point and it cannot fail.                                           │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export const bankFiltersSchema = z.object({
  q: z.string().trim().max(200).optional(),
  brandId: dbId().optional(),
  difficulty: difficultySchema.optional(),
  qtype: questionTypeSchema.optional(),
  status: questionStatusSchema.optional(),
  topicId: dbId().optional(),
  referenceDocumentId: dbId().optional(),
  /** The recycle bin. Deliberately a separate view, not a status value. */
  deleted: z.coerce.boolean().optional(),
  locale: bankLocaleSchema.default('en'),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .refine((n) => (BANK_PAGE_SIZES as readonly number[]).includes(n))
    .default(DEFAULT_BANK_PAGE_SIZE),
})

export type BankFilters = z.infer<typeof bankFiltersSchema>

/**
 * Parse URL search params into filters, never throwing and never discarding
 * more than the one value that was wrong.
 */
export function parseBankFilters(raw: Record<string, string | string[] | undefined>): BankFilters {
  const single = (key: string): string | undefined => {
    const v = raw[key]
    return Array.isArray(v) ? v[0] : v
  }

  // Field by field, so an unparseable `difficulty` cannot take the search term
  // down with it. Each falls back to "no filter", which is the safe direction:
  // showing more rows than asked for is visible, showing fewer is not.
  const pick = <T>(schema: z.ZodType<T>, key: string): T | undefined => {
    const value = single(key)
    if (value === undefined || value === '') return undefined
    const parsed = schema.safeParse(value)
    return parsed.success ? parsed.data : undefined
  }

  return {
    q: pick(z.string().trim().max(200), 'q'),
    brandId: pick(dbId(), 'brandId'),
    difficulty: pick(difficultySchema, 'difficulty'),
    qtype: pick(questionTypeSchema, 'qtype'),
    status: pick(questionStatusSchema, 'status'),
    topicId: pick(dbId(), 'topicId'),
    referenceDocumentId: pick(dbId(), 'referenceDocumentId'),
    deleted: single('deleted') === '1' || single('deleted') === 'true',
    locale: pick(bankLocaleSchema, 'locale') ?? 'en',
    page: pick(z.coerce.number().int().min(1).max(10_000), 'page') ?? 1,
    pageSize:
      pick(
        z.coerce
          .number()
          .int()
          .refine((n) => (BANK_PAGE_SIZES as readonly number[]).includes(n)),
        'pageSize',
      ) ?? DEFAULT_BANK_PAGE_SIZE,
  }
}

/** Is anything actually narrowing the list? Drives the empty-state wording. */
export function isNarrowed(filters: BankFilters): boolean {
  return Boolean(
    filters.q ||
      filters.difficulty ||
      filters.qtype ||
      filters.status ||
      filters.topicId ||
      filters.referenceDocumentId,
  )
}
