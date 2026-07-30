import { z } from 'zod'
import { dbId } from '@/lib/db/id'
import { questionStatusSchema } from './status'
import { bloomLevelSchema } from './metadata'
import type { ValidationIssue } from './schemas'

/**
 * Shapes and limits for bulk question operations.
 *
 * Outside the 'use server' module for the mechanical reason that such a file
 * may export only async functions, and for the same reason filters.ts lives
 * here: the client needs `BULK_LIMIT` to render "select all 340" honestly, and
 * a second copy of the number is how the button and the server end up
 * disagreeing about what happened.
 */

/**
 * Beyond this, "select all matching" stops being a click and becomes a job.
 *
 * Chosen against the shape of the work rather than a round number: 1,000 rows
 * is one indexed read and one UPDATE well inside a request, and a bank large
 * enough to exceed it is one where "change everything at once" deserves a
 * confirmation step nobody has designed yet.
 */
export const BULK_LIMIT = 1000

export interface BulkOutcome {
  ok: boolean
  error?: string
  applied: string[]
  /** id → why it did not apply, reported by the RPC rather than guessed. */
  skipped: { id: string; reason: string }[]
  /** Only from the publish path: which gate each failure tripped. */
  issues?: { id: string; issues: ValidationIssue[] }[]
}

/** One row of `bulk_update_questions` / `bulk_set_question_deleted`. */
export interface BulkRow {
  question_id: string
  applied: boolean
  reason: string | null
}

export function partitionBulkRows(rows: BulkRow[]): Pick<BulkOutcome, 'applied' | 'skipped'> {
  return {
    applied: rows.filter((r) => r.applied).map((r) => r.question_id),
    skipped: rows
      .filter((r) => !r.applied)
      .map((r) => ({ id: r.question_id, reason: r.reason ?? 'not updated' })),
  }
}

export const bulkIdsSchema = z.array(dbId()).min(1).max(BULK_LIMIT)

export const bulkUpdateSchema = z.object({
  ids: bulkIdsSchema,
  status: questionStatusSchema.optional(),
  categoryId: dbId().nullable().optional(),
  // `null` on categoryId already means "not requested", so clearing needs a
  // flag of its own — the same reason 0042 carries p_clear_category.
  clearCategory: z.boolean().optional(),
  difficulty: z.number().int().min(1).max(5).optional(),
  bloomLevel: bloomLevelSchema.optional(),
  clearBloom: z.boolean().optional(),
  addTagIds: z.array(dbId()).optional(),
  removeTagIds: z.array(dbId()).optional(),
})

export const bulkDeleteSchema = z.object({ ids: bulkIdsSchema, deleted: z.boolean() })

export const bulkPublishSchema = z.object({
  ids: bulkIdsSchema,
  to: questionStatusSchema.optional(),
})
