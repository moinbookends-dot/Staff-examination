import { z } from 'zod'

/**
 * Which columns the question bank may be sorted by.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THIS IS AN ALLOWLIST BECAUSE THE VALUE REACHES .order().                  │
 * │                                                                           │
 * │ PostgREST takes the column name as a string, so `?sort=` is attacker-     │
 * │ controlled input that names a database identifier. An unvalidated one is  │
 * │ at best a 400 on every page load from a mistyped bookmark, and at worst   │
 * │ an ordering by a column nobody meant to expose — `search_tsv` sorts       │
 * │ fine, and so would any column added to the table later.                   │
 * │                                                                           │
 * │ A denylist would need updating every time a column is added. This does    │
 * │ not: a new column is un-sortable until somebody decides otherwise, which  │
 * │ is the correct default.                                                   │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Only `updated_at` is indexed (0043). The rest sort in memory, which is fine
 * at this bank's size and is the reason the page size is bounded — see
 * QUESTION_PAGE_SIZES below.
 */
export const QUESTION_SORT_COLUMNS = [
  'updated_at',
  'stem',
  'type',
  'status',
  'difficulty',
  'marks',
  'bloom_level',
  'source',
  'usage_count',
  'revision',
] as const

export type QuestionSortColumn = (typeof QUESTION_SORT_COLUMNS)[number]

export const questionSortSchema = z.enum(QUESTION_SORT_COLUMNS)
export const sortDirectionSchema = z.enum(['asc', 'desc'])

export type SortDirection = z.infer<typeof sortDirectionSchema>

/** What the bank has shown since 0009, and what 0043's index supports. */
export const DEFAULT_SORT: QuestionSortColumn = 'updated_at'
export const DEFAULT_DIRECTION: SortDirection = 'desc'

/**
 * How many rows a page may hold.
 *
 * Bounded rather than free-form: the value becomes a `.range()`, so an
 * unvalidated `?pageSize=100000` turns one page render into a scan of the whole
 * company's bank plus two batched reads over every id on it. 100 is the point
 * past which a DOM table stops being the right answer anyway.
 */
export const QUESTION_PAGE_SIZES = [25, 50, 100] as const
export type QuestionPageSize = (typeof QUESTION_PAGE_SIZES)[number]
export const DEFAULT_PAGE_SIZE: QuestionPageSize = 25

export const pageSizeSchema = z.coerce
  .number()
  .int()
  .refine(
    (n): n is QuestionPageSize => (QUESTION_PAGE_SIZES as readonly number[]).includes(n),
    'Unsupported page size.',
  )

/**
 * What filtersToSearchParams should leave out of a link.
 *
 * Derived from the constants above rather than written out, so a change to the
 * default sort cannot leave `?sort=updated_at` decorating every URL.
 */
export const QUESTION_URL_DEFAULTS = {
  sort: DEFAULT_SORT,
  dir: DEFAULT_DIRECTION,
  pageSize: DEFAULT_PAGE_SIZE,
  deleted: false,
} as const
