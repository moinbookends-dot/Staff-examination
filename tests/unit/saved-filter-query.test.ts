import { describe, it, expect } from 'vitest'
import { filterQueryOf, saveFilterSchema } from '../../src/lib/questions/saved-filters'

/**
 * What a saved filter actually stores.
 *
 * A saved filter is a bookmark, and the two ways a bookmark goes wrong are
 * saving too much and saving it inconsistently. Both are asserted here because
 * neither is visible until somebody uses the feature for a week.
 */

describe('filterQueryOf', () => {
  it('keeps the filters', () => {
    const q = filterQueryOf('?status=draft&categoryId=abc&difficulty=4&bloomLevel=analyze')
    const params = new URLSearchParams(q)
    expect(params.get('status')).toBe('draft')
    expect(params.get('categoryId')).toBe('abc')
    expect(params.get('difficulty')).toBe('4')
    expect(params.get('bloomLevel')).toBe('analyze')
  })

  /**
   * The one that matters most. A filter saved from page 4 that always reopens
   * on page 4 shows an empty table the moment the result set shrinks, and reads
   * as a broken filter rather than a stale page number.
   */
  it('drops the page, so a saved filter never lands on an empty page', () => {
    const q = filterQueryOf('?status=draft&page=4')
    expect(new URLSearchParams(q).has('page')).toBe(false)
    expect(new URLSearchParams(q).get('status')).toBe('draft')
  })

  it('drops display state, which is not a filter', () => {
    const q = filterQueryOf('?status=draft&sort=stem&dir=asc&pageSize=100&deleted=1')
    const params = new URLSearchParams(q)
    for (const key of ['sort', 'dir', 'pageSize', 'deleted']) {
      expect(params.has(key), `${key} must not be saved`).toBe(false)
    }
    // Positive control: this test would pass against a function that returns
    // the empty string for everything.
    expect(params.get('status')).toBe('draft')
  })

  it('drops empty values, so clearing a filter does not save it as blank', () => {
    const q = filterQueryOf('?status=&type=mcq_single')
    const params = new URLSearchParams(q)
    expect(params.has('status')).toBe(false)
    expect(params.get('type')).toBe('mcq_single')
  })

  /**
   * The same filter reached by choosing status then category, or category then
   * status, must save as one string — otherwise `unique (owner_id, name)` is
   * doing nothing useful and the menu fills with duplicates that look identical.
   */
  it('is order-independent', () => {
    expect(filterQueryOf('?status=draft&difficulty=4')).toBe(
      filterQueryOf('?difficulty=4&status=draft'),
    )
  })

  it('accepts a query string with or without its leading ?', () => {
    expect(filterQueryOf('?status=draft')).toBe(filterQueryOf('status=draft'))
  })

  it('produces nothing for an unfiltered view', () => {
    expect(filterQueryOf('?page=2&sort=stem')).toBe('')
  })
})

describe('saveFilterSchema', () => {
  it('requires a name', () => {
    expect(saveFilterSchema.safeParse({ name: '   ', query: 'status=draft' }).success).toBe(false)
    expect(saveFilterSchema.safeParse({ name: 'Needs Bloom', query: 'status=draft' }).success).toBe(
      true,
    )
  })

  it('refuses a name longer than the column allows', () => {
    // 0043 checks `length(btrim(name)) between 1 and 80`. Rejecting it here
    // means a too-long name is a field error, not a 500 from the database.
    expect(saveFilterSchema.safeParse({ name: 'x'.repeat(81), query: '' }).success).toBe(false)
    expect(saveFilterSchema.safeParse({ name: 'x'.repeat(80), query: '' }).success).toBe(true)
  })

  /**
   * Deliberately permissive about the query's CONTENTS. Validating the filter
   * here would be a second definition of what a filter means — the thing 0043
   * exists to avoid — and a saved filter naming a since-deleted category must
   * degrade like a stale bookmark, which parseQuestionFilters already handles.
   */
  it('does not judge what the query says', () => {
    expect(
      saveFilterSchema.safeParse({ name: 'Odd', query: 'status=nonsense&categoryId=gone' }).success,
    ).toBe(true)
  })
})
