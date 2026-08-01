import { describe, it, expect } from 'vitest'
import {
  DEFAULT_DIRECTION,
  DEFAULT_PAGE_SIZE,
  DEFAULT_SORT,
  pageSizeSchema,
  QUESTION_PAGE_SIZES,
  QUESTION_SORT_COLUMNS,
  QUESTION_URL_DEFAULTS,
  questionSortSchema,
  sortDirectionSchema,
} from '../../src/lib/questions/sort'
import { parseQuestionFilters } from '../../src/lib/questions/filters'
import { filtersToSearchParams } from '../../src/lib/search-params'

/**
 * The sort allowlist, which is load-bearing.
 *
 * `?sort=` reaches PostgREST's .order() as a column name, so it is
 * attacker-controlled input naming a database identifier. Both directions are
 * asserted: "everything on the list is accepted" alone passes against a schema
 * that accepts anything, and "junk is rejected" alone passes against one that
 * accepts nothing and leaves the table unsortable.
 */

describe('the sort allowlist', () => {
  it('accepts every column the table offers', () => {
    for (const column of QUESTION_SORT_COLUMNS) {
      expect(questionSortSchema.safeParse(column).success, column).toBe(true)
    }
  })

  it('rejects anything else', () => {
    for (const junk of [
      'search_tsv',
      'company_id',
      'deleted_at',
      'id; drop table questions',
      'stem desc',
      '',
      'STEM',
    ]) {
      expect(questionSortSchema.safeParse(junk).success, junk).toBe(false)
    }
  })

  it('offers more than one column, so sorting means something', () => {
    // Guards against the list being emptied down to the default, which would
    // make every assertion above pass while the feature did nothing.
    expect(QUESTION_SORT_COLUMNS.length).toBeGreaterThan(1)
    expect(QUESTION_SORT_COLUMNS).toContain(DEFAULT_SORT)
  })

  it('takes only two directions', () => {
    expect(sortDirectionSchema.safeParse('asc').success).toBe(true)
    expect(sortDirectionSchema.safeParse('desc').success).toBe(true)
    expect(sortDirectionSchema.safeParse('random').success).toBe(false)
    expect(sortDirectionSchema.safeParse('ASC').success).toBe(false)
  })
})

describe('the page size', () => {
  it('accepts the offered sizes and coerces the string a URL carries', () => {
    for (const size of QUESTION_PAGE_SIZES) {
      expect(pageSizeSchema.safeParse(size).success, String(size)).toBe(true)
      expect(pageSizeSchema.safeParse(String(size)).success, String(size)).toBe(true)
    }
  })

  /**
   * The reason this is bounded rather than a min/max. The value becomes a
   * .range(), and one page render also drives two batched reads keyed on every
   * id it returned — so an unbounded page size turns one request into a scan of
   * the company's whole bank.
   */
  it('refuses a hand-edited size', () => {
    for (const junk of [100000, 0, -1, 26, 1000, 24.5]) {
      expect(pageSizeSchema.safeParse(junk).success, String(junk)).toBe(false)
    }
  })
})

describe('sort and page size in the URL', () => {
  it('falls back rather than erroring on nonsense', () => {
    const filters = parseQuestionFilters({
      sort: 'search_tsv',
      dir: 'sideways',
      pageSize: '100000',
      status: 'draft',
    })
    expect(filters.sort).toBe(DEFAULT_SORT)
    expect(filters.dir).toBe(DEFAULT_DIRECTION)
    expect(filters.pageSize).toBe(DEFAULT_PAGE_SIZE)
    // And the rest of the query survives — the whole point of dropping only
    // the offending key. A bookmark with a stale sort is still a filtered view.
    expect(filters.status).toBe('draft')
  })

  it('keeps a sort that is valid', () => {
    const filters = parseQuestionFilters({ sort: 'difficulty', dir: 'asc', pageSize: '50' })
    expect(filters.sort).toBe('difficulty')
    expect(filters.dir).toBe('asc')
    expect(filters.pageSize).toBe(50)
  })

  it('reads the recycle-bin flag from the string a URL carries', () => {
    expect(parseQuestionFilters({ deleted: '1' }).deleted).toBe(true)
    expect(parseQuestionFilters({ deleted: 'true' }).deleted).toBe(true)
    // The one that matters: every non-empty string is truthy, so a naive
    // read of `?deleted=false` would open the recycle bin.
    expect(parseQuestionFilters({ deleted: 'false' }).deleted).toBe(false)
    expect(parseQuestionFilters({ deleted: '0' }).deleted).toBe(false)
    expect(parseQuestionFilters({}).deleted).toBe(false)
  })

  it('leaves the defaults out of a shared link', () => {
    const filters = parseQuestionFilters({ status: 'draft' })
    const query = filtersToSearchParams(filters, QUESTION_URL_DEFAULTS)
    const params = new URLSearchParams(query)

    expect(params.get('status')).toBe('draft')
    for (const key of Object.keys(QUESTION_URL_DEFAULTS)) {
      expect(params.has(key), `${key} restates a default`).toBe(false)
    }
  })

  it('still carries a sort that is not the default', () => {
    const filters = parseQuestionFilters({ sort: 'stem', dir: 'asc' })
    const params = new URLSearchParams(filtersToSearchParams(filters, QUESTION_URL_DEFAULTS))
    expect(params.get('sort')).toBe('stem')
    expect(params.get('dir')).toBe('asc')
  })
})
