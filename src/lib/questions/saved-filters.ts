import { z } from 'zod'
import { dbId } from '@/lib/db/id'

/**
 * Shapes for a chef's own saved question-bank filters.
 *
 * Outside the 'use server' module for the usual mechanical reason — such a file
 * may export only async functions — and so the menu component can validate a
 * name before making a round trip.
 */

/** Matches 0043's check constraint. Restated here so the form says so first. */
export const SAVED_FILTER_NAME_MAX = 80
export const SAVED_FILTER_QUERY_MAX = 2000

export interface SavedFilter {
  id: string
  name: string
  /** The URL query string, without the leading '?'. */
  query: string
}

export const saveFilterSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Give the filter a name.')
    .max(SAVED_FILTER_NAME_MAX, 'That name is too long.'),
  /**
   * Accepted as an opaque string and re-parsed on the way back out.
   *
   * Validating the filter's *contents* here would be a second definition of
   * what a filter means, which is the thing 0043 exists to avoid. A saved
   * filter is a bookmark: it is allowed to name a category that is later
   * deleted, and parseQuestionFilters already knows what to do about that.
   */
  query: z.string().max(SAVED_FILTER_QUERY_MAX, 'That filter is too complex to save.'),
})

export const deleteFilterSchema = z.object({ id: dbId() })

/**
 * Strip the parts of a query string that are not a filter.
 *
 * `page` is the obvious one — a saved filter that always lands on page 4 is a
 * bug that would take a while to explain. Selection and sort are display state
 * rather than a filter, and saving them would mean a shared "Needs Bloom"
 * silently re-sorted the bank for whoever opened it.
 */
const NOT_A_FILTER = new Set(['page', 'pageSize', 'sort', 'dir', 'deleted'])

export function filterQueryOf(search: string): string {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  for (const key of NOT_A_FILTER) params.delete(key)
  // Sorted, so the same filter reached from two directions saves as one string
  // and the unique(owner_id, name) constraint means what a person expects.
  const entries = [...params.entries()].filter(([, v]) => v !== '').sort(([a], [b]) => a.localeCompare(b))
  return new URLSearchParams(entries).toString()
}
