import { z } from 'zod'
import { examKindSchema } from './rules'

/**
 * Exam list filters.
 *
 * Outside the 'use server' action module for the same two reasons as the
 * question bank's: a 'use server' file may export only async functions, and the
 * list page needs to parse `searchParams` with the identical schema the action
 * validates against. One schema, so a URL somebody bookmarked and a call the
 * client makes are checked by the same rules.
 */
export const examStatusFilterSchema = z.enum([
  'draft',
  'scheduled',
  'active',
  'completed',
  'archived',
  'cancelled',
])

export const examFiltersSchema = z.object({
  status: examStatusFilterSchema.optional(),
  kind: examKindSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
})

export type ExamFilters = z.infer<typeof examFiltersSchema>

export const EXAMS_PAGE_SIZE = 25
