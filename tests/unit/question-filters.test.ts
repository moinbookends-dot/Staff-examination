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
    // Asserted field by field rather than with one toEqual on the whole object.
    // The schema carries defaults now — sort, dir, pageSize, deleted — so a
    // whole-object comparison breaks every time a field is added, which teaches
    // whoever hits it to update the expectation without reading it.
    const filters = parseQuestionFilters({ q: 'knife', difficulty: '4', status: 'active', page: '2' })
    expect(filters.q).toBe('knife')
    expect(filters.difficulty).toBe(4)
    expect(filters.status).toBe('active')
    expect(filters.page).toBe(2)
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
    for (const input of [undefined, {}]) {
      const filters = parseQuestionFilters(input)
      expect(filters.page).toBe(1)
      expect(filters.q).toBeUndefined()
      expect(filters.status).toBeUndefined()
    }
  })

  /**
   * The fallback used to return the literal `{ page: 1 }`, which was correct
   * exactly until the schema gained a default. A caller reading `filters.sort`
   * off that object would have got `undefined` and passed it to .order(), and
   * PostgREST answers an undefined column with a 400 — on the recovery path,
   * which is the one nobody exercises by hand.
   *
   * It parses an empty object now, so the defaults can only ever come from the
   * schema. Asserted by comparing against a query that needed no recovery.
   */
  it('gives the recovery path the same defaults as a clean parse', () => {
    const recovered = parseQuestionFilters({ status: 'nonsense', difficulty: '99' })
    const clean = parseQuestionFilters({})

    expect(recovered.sort).toBe(clean.sort)
    expect(recovered.dir).toBe(clean.dir)
    expect(recovered.pageSize).toBe(clean.pageSize)
    expect(recovered.deleted).toBe(clean.deleted)
    // A positive control: these are real values, not two matching undefineds.
    expect(clean.sort).toBeTruthy()
    expect(clean.pageSize).toBeGreaterThan(0)
  })
})
