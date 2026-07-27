import { z } from 'zod'
import { dbId } from '@/lib/db/id'
import { questionTypeSchema } from './schemas'

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
  status: z.enum(['draft', 'active', 'retired']).optional(),
  type: questionTypeSchema.optional(),
  categoryId: dbId().optional(),
  difficulty: z.coerce.number().int().min(1).max(5).optional(),
  page: z.coerce.number().int().min(1).default(1),
})

export type QuestionFilters = z.infer<typeof questionFiltersSchema>

export const QUESTIONS_PAGE_SIZE = 25

/**
 * Filters → query string, dropping empties.
 *
 * Empty values are omitted rather than serialised as `status=`, so the URL
 * stays readable and a bookmark does not accumulate dead parameters every time
 * someone clears a filter.
 */
export function filtersToSearchParams(
  filters: Partial<Record<keyof QuestionFilters, string | number | undefined>>,
): string {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '') continue
    // page=1 is the default; carrying it makes every URL look filtered.
    if (key === 'page' && Number(value) <= 1) continue
    params.set(key, String(value))
  }
  return params.toString()
}
