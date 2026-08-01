import { z } from 'zod'
import { dbId } from '@/lib/db/id'
import { questionTypeSchema } from './schemas'
import { questionStatusSchema } from './status'
import { bloomLevelSchema, questionSourceSchema } from './metadata'
import {
  DEFAULT_DIRECTION,
  DEFAULT_PAGE_SIZE,
  DEFAULT_SORT,
  pageSizeSchema,
  questionSortSchema,
  sortDirectionSchema,
} from './sort'

/**
 * Question bank filters.
 *
 * Lives outside the server-action module for two reasons. The mechanical one:
 * a 'use server' file may export only async functions, and this is a value.
 * The real one: the same schema parses `searchParams` on the list page and the
 * argument to listQuestions(), so a URL a chef bookmarked and a call the client
 * makes are validated by identical rules. Coercion matters here — everything
 * arriving from a query string is a string, including `page` and `difficulty`.
 *
 * This shape is also what M3's exam builder will store as a rule-based question
 * pool. Saved filters were chosen over pool membership tables (see CHANGELOG)
 * because membership goes stale: a question added next week belongs to no pool
 * until somebody remembers to add it.
 */
export const questionFiltersSchema = z.object({
  q: z.string().trim().max(200).optional(),
  // From src/lib/questions/status.ts, not spelled out again. This enum listed
  // three of the seven statuses the database has, so `?status=approved` parsed
  // as invalid — and because of the fallback below, silently discarded the
  // search term, the category and the difficulty along with it.
  status: questionStatusSchema.optional(),
  type: questionTypeSchema.optional(),
  categoryId: dbId().optional(),
  difficulty: z.coerce.number().int().min(1).max(5).optional(),
  bloomLevel: bloomLevelSchema.optional(),
  source: questionSourceSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),

  // Display state, parsed by the same schema so a sorted view is as shareable
  // as a filtered one. All three fall back rather than erroring — the recovery
  // below drops only the offending key, so a stale `?sort=` costs its own
  // column and not the whole query.
  sort: questionSortSchema.default(DEFAULT_SORT),
  dir: sortDirectionSchema.default(DEFAULT_DIRECTION),
  pageSize: pageSizeSchema.default(DEFAULT_PAGE_SIZE),

  /**
   * The recycle bin. Requires questions.retire, which 0041's
   * questions_read_deleted enforces — this flag only asks for the rows, it does
   * not grant them, and a candidate setting it by hand sees nothing.
   */
  deleted: z
    .union([z.boolean(), z.enum(['1', 'true', '0', 'false'])])
    .transform((v) => v === true || v === '1' || v === 'true')
    .default(false),
})

export type QuestionFilters = z.infer<typeof questionFiltersSchema>

/**
 * Parse filters, keeping whatever is valid.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHY NOT JUST safeParse().data ?? { page: 1 }                              │
 * │                                                                           │
 * │ That was the previous behaviour in BOTH the action and the page, and it   │
 * │ throws away the whole query when any one part of it is unrecognised. A    │
 * │ bookmarked                                                                │
 * │                                                                           │
 * │     /questions?q=knife&categoryId=…&difficulty=4&status=approved          │
 * │                                                                           │
 * │ where `approved` is a status this schema had never heard of did not come  │
 * │ back with the status ignored — it came back with everything ignored, as   │
 * │ the unfiltered first page, silently. The person then reads the wrong list │
 * │ believing it is filtered.                                                 │
 * │                                                                           │
 * │ Dropping only the offending key is what a URL somebody kept for six months│
 * │ deserves, and it is the failure mode that survives the NEXT enum change   │
 * │ too.                                                                      │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export function parseQuestionFilters(input: unknown): QuestionFilters {
  const parsed = questionFiltersSchema.safeParse(input ?? {})
  if (parsed.success) return parsed.data

  // Re-parse with the keys Zod objected to removed. Path[0] is the field name;
  // anything deeper is inside a value this schema treats as a scalar, so the
  // whole field goes.
  const offending = new Set(
    parsed.error.issues.map((issue) => String(issue.path[0])).filter(Boolean),
  )
  const kept: Record<string, unknown> = {}
  for (const [key, value] of Object.entries((input ?? {}) as Record<string, unknown>)) {
    if (!offending.has(key)) kept[key] = value
  }

  const retry = questionFiltersSchema.safeParse(kept)
  if (retry.success) return retry.data

  // Everything was offensive. Parsing an empty object rather than writing the
  // defaults out by hand, so this can never disagree with the schema — the
  // literal it used to return listed `page` alone, and would have been missing
  // sort, dir and pageSize the moment they were added.
  return questionFiltersSchema.parse({})
}

// QUESTIONS_PAGE_SIZE used to live here as a module constant. It is gone
// because the page size is now chosen per request and validated against
// QUESTION_PAGE_SIZES in ./sort — a constant and a parameter for the same
// number is how the two end up disagreeing about what a page holds.
