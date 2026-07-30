import { describe, it, expect } from 'vitest'
import { parseQuestionFilters } from '../../src/lib/questions/filters'

/**
 * The filter fallback.
 *
 * Both the action and the page used to do
 * `safeParse(raw).success ? data : { page: 1 }`, which discards the WHOLE query
 * when any one part of it is unrecognised. That was invisible while the status
 * enum had three values and every URL in existence used one of them. 0037 added
 * four more, and a bookmarked
 *
 *     /questions?q=knife&difficulty=4&status=approved
 *
 * came back not as "the status was ignored" but as the unfiltered first page —
 * silently, with the person reading the wrong list believing it was filtered.
 */
describe('parseQuestionFilters', () => {
  it('keeps a fully valid query', () => {
    expect(parseQuestionFilters({ q: 'knife', difficulty: '4', status: 'active', page: '2' })).toEqual({
      q: 'knife',
      difficulty: 4,
      status: 'active',
      page: 2,
    })
  })

  it('accepts every status the database has', () => {
    for (const status of ['draft', 'review', 'active', 'approved', 'retired', 'archived', 'deprecated']) {
      expect(parseQuestionFilters({ status }).status, status).toBe(status)
    }
  })

  it('drops only the offending key, keeping the rest of the query', () => {
    const filters = parseQuestionFilters({ q: 'knife', difficulty: '4', status: 'nonsense' })
    expect(filters.q).toBe('knife')
    expect(filters.difficulty).toBe(4)
    expect(filters.status).toBeUndefined()
  })

  it('drops several bad keys without taking the good ones with them', () => {
    const filters = parseQuestionFilters({ q: 'knife', status: 'nonsense', difficulty: '99', page: '3' })
    expect(filters.q).toBe('knife')
    expect(filters.status).toBeUndefined()
    expect(filters.difficulty).toBeUndefined()
    expect(filters.page).toBe(3)
  })

  it('falls back to page one when there is nothing salvageable', () => {
    expect(parseQuestionFilters(undefined)).toEqual({ page: 1 })
    expect(parseQuestionFilters({})).toEqual({ page: 1 })
  })
})
