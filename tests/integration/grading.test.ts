import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { Client } from 'pg'
import { connect, hasDatabase, asOwner, asUser, employee } from './helpers/db'
import { FORMAT_REGISTRY } from '@/lib/questions/registry'
import { RESPONSE_FORMATS } from '@/lib/questions/schemas'

/**
 * The auto-grader.
 *
 * This is the highest-value test target in the codebase: a bug here silently
 * produces wrong scores that a human will trust and act on, and nobody audits a
 * number that looks plausible.
 *
 * It lives in the integration suite rather than the unit suite because the
 * grader is SQL — see the header of migration 0027 for why. The engine it
 * replaced (src/lib/questions/grading.ts) was proven equivalent case by case
 * before it was deleted; every expectation below was carried across from it.
 */

const describeDb = hasDatabase ? describe : describe.skip

interface Expectation {
  name: string
  content: unknown
  key: unknown
  answer: unknown
  max: number
  negative?: number
  score: number
  status: 'graded' | 'needs_review' | 'not_applicable'
  review?: boolean
}

const SINGLE = {
  format: 'choice_single',
  choices: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }, { id: 'c', text: 'C' }],
}
const MULTI = {
  format: 'choice_multi',
  choices: [
    { id: 'a', text: 'A' }, { id: 'b', text: 'B' },
    { id: 'c', text: 'C' }, { id: 'd', text: 'D' },
  ],
}
const ORDER = { format: 'order', items: [{ id: 'x' }, { id: 'y' }, { id: 'z' }, { id: 'w' }] }
const PAIRS = { format: 'pairs', left: [], right: [] }
const BLANKS = { format: 'blanks', template: '{{one}} {{two}}', blanks: [{ id: 'one' }, { id: 'two' }] }

const blanksKey = (
  one: Record<string, unknown>,
  two: Record<string, unknown>,
  partial = true,
) => ({ format: 'blanks', partialCredit: partial, blanks: [{ id: 'one', ...one }, { id: 'two', ...two }] })

const GROUPS: Array<[string, Expectation[]]> = [
  ['single choice', [
    { name: 'correct answer scores full marks', content: SINGLE,
      key: { format: 'choice_single', correct: 'b' },
      answer: { format: 'choice_single', choice: 'b' }, max: 3, score: 3, status: 'graded' },
    { name: 'wrong answer scores zero when there is no negative marking', content: SINGLE,
      key: { format: 'choice_single', correct: 'b' },
      answer: { format: 'choice_single', choice: 'a' }, max: 3, score: 0, status: 'graded' },
    { name: 'wrong answer incurs the negative mark', content: SINGLE,
      key: { format: 'choice_single', correct: 'b' },
      answer: { format: 'choice_single', choice: 'a' }, max: 3, negative: 1, score: -1, status: 'graded' },
    // The contract that makes the whole thing honest: penalising a skip would
    // make guessing strictly better than admitting ignorance.
    { name: 'a skipped question is never penalised, even with negative marking', content: SINGLE,
      key: { format: 'choice_single', correct: 'b' },
      answer: { format: 'choice_single', choice: null }, max: 3, negative: 1, score: 0, status: 'graded' },
    { name: 'an absent answer is never penalised', content: SINGLE,
      key: { format: 'choice_single', correct: 'b' },
      answer: null, max: 3, negative: 2, score: 0, status: 'graded' },
  ]],

  ['multiple choice', [
    { name: 'all correct, no partial credit', content: MULTI,
      key: { format: 'choice_multi', correct: ['a', 'b'] },
      answer: { format: 'choice_multi', choices: ['a', 'b'] }, max: 4, score: 4, status: 'graded' },
    { name: 'incomplete without partial credit takes the penalty', content: MULTI,
      key: { format: 'choice_multi', correct: ['a', 'b'] },
      answer: { format: 'choice_multi', choices: ['a'] }, max: 4, negative: 1, score: -1, status: 'graded' },
    { name: 'partial credit awards the proportion found', content: MULTI,
      key: { format: 'choice_multi', correct: ['a', 'b'], partialCredit: true },
      answer: { format: 'choice_multi', choices: ['a'] }, max: 4, score: 2, status: 'graded' },
    { name: 'a wrong pick cancels a right one', content: MULTI,
      key: { format: 'choice_multi', correct: ['a', 'b'], partialCredit: true },
      answer: { format: 'choice_multi', choices: ['a', 'c'] }, max: 4, score: 0, status: 'graded' },
    // Without the miss penalty this scores full marks and the question measures
    // nothing at all.
    { name: 'ticking every box scores zero', content: MULTI,
      key: { format: 'choice_multi', correct: ['a', 'b'], partialCredit: true },
      answer: { format: 'choice_multi', choices: ['a', 'b', 'c', 'd'] }, max: 4, score: 0, status: 'graded' },
    { name: 'partial credit floors at zero rather than going negative', content: MULTI,
      key: { format: 'choice_multi', correct: ['a', 'b'], partialCredit: true },
      answer: { format: 'choice_multi', choices: ['c', 'd'] }, max: 4, score: 0, status: 'graded' },
    { name: 'no selection is a skip, not a wrong answer', content: MULTI,
      key: { format: 'choice_multi', correct: ['a', 'b'], partialCredit: true },
      answer: { format: 'choice_multi', choices: [] }, max: 4, negative: 2, score: 0, status: 'graded' },
    { name: 'a repeating proportion rounds to two places', content: MULTI,
      key: { format: 'choice_multi', correct: ['a', 'b', 'c'], partialCredit: true },
      answer: { format: 'choice_multi', choices: ['a'] }, max: 5, score: 1.67, status: 'graded' },
  ]],

  ['true / false', [
    { name: 'correct true', content: { format: 'boolean' }, key: { format: 'boolean', correct: true },
      answer: { format: 'boolean', value: true }, max: 1, score: 1, status: 'graded' },
    { name: 'correct false', content: { format: 'boolean' }, key: { format: 'boolean', correct: false },
      answer: { format: 'boolean', value: false }, max: 1, score: 1, status: 'graded' },
    { name: 'wrong takes the penalty', content: { format: 'boolean' }, key: { format: 'boolean', correct: false },
      answer: { format: 'boolean', value: true }, max: 1, negative: 0.5, score: -0.5, status: 'graded' },
    { name: 'unanswered is not wrong', content: { format: 'boolean' }, key: { format: 'boolean', correct: false },
      answer: { format: 'boolean', value: null }, max: 1, negative: 0.5, score: 0, status: 'graded' },
  ]],

  ['blanks', [
    { name: 'case-insensitive matching ignores case and collapses whitespace', content: BLANKS,
      key: blanksKey({ accept: ['five'], match: 'ci' }, { accept: ['sixty three'], match: 'ci' }),
      answer: { format: 'blanks', values: { one: 'FIVE', two: '  sixty   three ' } },
      max: 4, score: 4, status: 'graded' },
    { name: 'partial credit per blank', content: BLANKS,
      key: blanksKey({ accept: ['five'], match: 'ci' }, { accept: ['sixty three'], match: 'ci' }),
      answer: { format: 'blanks', values: { one: 'five', two: 'nope' } }, max: 4, score: 2, status: 'graded' },
    { name: 'without partial credit one wrong blank fails the question', content: BLANKS,
      key: blanksKey({ accept: ['five'], match: 'ci' }, { accept: ['six'], match: 'ci' }, false),
      answer: { format: 'blanks', values: { one: 'five', two: 'nope' } },
      max: 4, negative: 1, score: -1, status: 'graded' },
    { name: 'exact matching is case sensitive', content: BLANKS,
      key: blanksKey({ accept: ['Five'], match: 'exact' }, { accept: ['Six'], match: 'exact' }),
      answer: { format: 'blanks', values: { one: 'five', two: 'Six' } }, max: 2, score: 1, status: 'graded' },
    // Across four languages a near-match is far more often a spelling variant
    // than a wrong answer, so it is credited — but never silently.
    { name: 'a fuzzy near-miss is credited and flagged for a human', content: BLANKS,
      key: blanksKey({ accept: ['chicken'], match: 'fuzzy' }, { accept: ['salmon'], match: 'fuzzy' }),
      answer: { format: 'blanks', values: { one: 'chickn', two: 'salmon' } },
      max: 4, score: 4, status: 'needs_review', review: true },
    { name: 'fuzzy matching is refused under four characters', content: BLANKS,
      key: blanksKey({ accept: ['rib'], match: 'fuzzy' }, { accept: ['pan'], match: 'fuzzy' }),
      answer: { format: 'blanks', values: { one: 'rub', two: 'pan' } },
      max: 4, score: 2, status: 'graded' },
    { name: 'an explicit tolerance widens the fuzzy match', content: BLANKS,
      key: blanksKey({ accept: ['chicken'], match: 'fuzzy', tolerance: 2 }, { accept: ['beef'], match: 'ci' }),
      answer: { format: 'blanks', values: { one: 'chikn', two: 'beef' } },
      max: 4, score: 4, status: 'needs_review', review: true },
    // An unanchored /74/ would accept "not 74", which is the opposite answer.
    { name: 'regex blanks are anchored and reject a substring match', content: BLANKS,
      key: blanksKey({ accept: ['74'], match: 'regex' }, { accept: ['5|five'], match: 'regex' }),
      answer: { format: 'blanks', values: { one: 'not 74', two: 'five' } },
      max: 4, score: 2, status: 'graded' },
    { name: 'regex alternation and classes match case-insensitively', content: BLANKS,
      key: blanksKey({ accept: ['7[0-9]'], match: 'regex' }, { accept: ['a|b'], match: 'regex' }),
      answer: { format: 'blanks', values: { one: '74', two: 'B' } }, max: 4, score: 4, status: 'graded' },
    // An authoring fault must not be charged to the candidate.
    { name: 'an invalid regex sends the answer to a human instead of failing it', content: BLANKS,
      key: blanksKey({ accept: ['[unclosed'], match: 'regex' }, { accept: ['x'], match: 'ci' }),
      answer: { format: 'blanks', values: { one: 'anything', two: 'x' } },
      max: 4, score: 2, status: 'needs_review', review: true },
    { name: 'all blanks empty is a skip', content: BLANKS,
      key: blanksKey({ accept: ['five'], match: 'ci' }, { accept: ['six'], match: 'ci' }),
      answer: { format: 'blanks', values: { one: '', two: '   ' } },
      max: 4, negative: 2, score: 0, status: 'graded' },
    { name: 'a missing value is treated as blank', content: BLANKS,
      key: blanksKey({ accept: ['five'], match: 'ci' }, { accept: ['six'], match: 'ci' }),
      answer: { format: 'blanks', values: { one: 'five' } }, max: 4, score: 2, status: 'graded' },
    // Devanagari and Gujarati have multiple valid encodings for the same
    // visible character; the same word typed on a different keyboard must match.
    { name: 'NFKC normalisation makes halfwidth and fullwidth equal', content: BLANKS,
      key: blanksKey({ accept: ['カ'], match: 'ci' }, { accept: ['x'], match: 'ci' }),
      answer: { format: 'blanks', values: { one: 'ｶ', two: 'x' } }, max: 2, score: 2, status: 'graded' },
  ]],

  ['pairs', [
    { name: 'all pairs correct', content: PAIRS, key: { format: 'pairs', correct: { l1: 'r1', l2: 'r2' } },
      answer: { format: 'pairs', mapping: { l1: 'r1', l2: 'r2' } }, max: 4, score: 4, status: 'graded' },
    { name: 'partial credit per pair', content: PAIRS,
      key: { format: 'pairs', correct: { l1: 'r1', l2: 'r2' }, partialCredit: true },
      answer: { format: 'pairs', mapping: { l1: 'r1', l2: 'rX' } }, max: 4, score: 2, status: 'graded' },
    { name: 'without partial credit one wrong pair fails the question', content: PAIRS,
      key: { format: 'pairs', correct: { l1: 'r1', l2: 'r2' } },
      answer: { format: 'pairs', mapping: { l1: 'r1', l2: 'rX' } },
      max: 4, negative: 1, score: -1, status: 'graded' },
    { name: 'an unmapped left item is wrong, not an error', content: PAIRS,
      key: { format: 'pairs', correct: { l1: 'r1', l2: 'r2' }, partialCredit: true },
      answer: { format: 'pairs', mapping: { l1: 'r1' } }, max: 4, score: 2, status: 'graded' },
    { name: 'an empty mapping is a skip', content: PAIRS,
      key: { format: 'pairs', correct: { l1: 'r1', l2: 'r2' }, partialCredit: true },
      answer: { format: 'pairs', mapping: {} }, max: 4, negative: 2, score: 0, status: 'graded' },
  ]],

  ['ordering', [
    { name: 'exact scoring, right order', content: ORDER,
      key: { format: 'order', correct: ['x', 'y', 'z', 'w'], scoring: 'exact' },
      answer: { format: 'order', order: ['x', 'y', 'z', 'w'] }, max: 4, score: 4, status: 'graded' },
    { name: 'exact scoring gives nothing for one swap', content: ORDER,
      key: { format: 'order', correct: ['x', 'y', 'z', 'w'], scoring: 'exact' },
      answer: { format: 'order', order: ['x', 'y', 'w', 'z'] },
      max: 4, negative: 1, score: -1, status: 'graded' },
    // Getting the first steps of a recipe right is worth something even if two
    // later steps are swapped.
    { name: 'adjacent scoring, perfect sequence', content: ORDER,
      key: { format: 'order', correct: ['x', 'y', 'z', 'w'], scoring: 'adjacent' },
      answer: { format: 'order', order: ['x', 'y', 'z', 'w'] }, max: 6, score: 6, status: 'graded' },
    { name: 'adjacent scoring credits the pairs that survived', content: ORDER,
      key: { format: 'order', correct: ['x', 'y', 'z', 'w'], scoring: 'adjacent' },
      answer: { format: 'order', order: ['x', 'y', 'w', 'z'] }, max: 6, score: 2, status: 'graded' },
    { name: 'adjacent scoring, fully reversed', content: ORDER,
      key: { format: 'order', correct: ['x', 'y', 'z', 'w'], scoring: 'adjacent' },
      answer: { format: 'order', order: ['w', 'z', 'y', 'x'] }, max: 6, score: 0, status: 'graded' },
    { name: 'kendall scoring, perfect sequence', content: ORDER,
      key: { format: 'order', correct: ['x', 'y', 'z', 'w'], scoring: 'kendall' },
      answer: { format: 'order', order: ['x', 'y', 'z', 'w'] }, max: 6, score: 6, status: 'graded' },
    { name: 'kendall scoring rewards a broadly-right sequence', content: ORDER,
      key: { format: 'order', correct: ['x', 'y', 'z', 'w'], scoring: 'kendall' },
      answer: { format: 'order', order: ['y', 'x', 'z', 'w'] }, max: 6, score: 5, status: 'graded' },
    { name: 'kendall scoring, fully reversed', content: ORDER,
      key: { format: 'order', correct: ['x', 'y', 'z', 'w'], scoring: 'kendall' },
      answer: { format: 'order', order: ['w', 'z', 'y', 'x'] }, max: 6, score: 0, status: 'graded' },
    { name: 'kendall scoring ignores pairs the candidate did not place', content: ORDER,
      key: { format: 'order', correct: ['x', 'y', 'z', 'w'], scoring: 'kendall' },
      answer: { format: 'order', order: ['x', 'y', 'z'] }, max: 6, score: 6, status: 'graded' },
    { name: 'an empty order is a skip', content: ORDER,
      key: { format: 'order', correct: ['x', 'y', 'z', 'w'], scoring: 'adjacent' },
      answer: { format: 'order', order: [] }, max: 6, negative: 2, score: 0, status: 'graded' },
  ]],

  // ── 0034: a blank answered in the language it was asked in ────────────────
  ['blanks across languages', [
    {
      name: 'accepts the Gujarati answer to a Gujarati question', content: BLANKS,
      key: {
        format: 'blanks', partialCredit: true,
        blanks: [
          { id: 'one', accept: ['five'], match: 'ci', acceptByLocale: { gu: ['પાંચ'], hi: ['पाँच'] } },
          { id: 'two', accept: ['x'], match: 'ci' },
        ],
      },
      answer: { format: 'blanks', values: { one: 'પાંચ', two: 'x' } },
      max: 2, score: 2, status: 'graded',
    },
    {
      // The reason this is a union and not locale-scoped grading: a Gujarati
      // cook types the English word because that is what the kitchen calls it.
      name: 'still accepts the English answer from a Gujarati speaker', content: BLANKS,
      key: {
        format: 'blanks', partialCredit: true,
        blanks: [
          { id: 'one', accept: ['five'], match: 'ci', acceptByLocale: { gu: ['પાંચ'] } },
          { id: 'two', accept: ['x'], match: 'ci' },
        ],
      },
      answer: { format: 'blanks', values: { one: 'five', two: 'x' } },
      max: 2, score: 2, status: 'graded',
    },
    {
      name: 'accepts Hindi on the same blank as Gujarati', content: BLANKS,
      key: {
        format: 'blanks', partialCredit: true,
        blanks: [
          { id: 'one', accept: ['five'], match: 'ci', acceptByLocale: { gu: ['પાંચ'], hi: ['पाँच'] } },
          { id: 'two', accept: ['x'], match: 'ci' },
        ],
      },
      answer: { format: 'blanks', values: { one: 'पाँच', two: 'x' } },
      max: 2, score: 2, status: 'graded',
    },
    {
      name: 'still marks a genuinely wrong answer wrong', content: BLANKS,
      key: {
        format: 'blanks', partialCredit: true,
        blanks: [
          { id: 'one', accept: ['five'], match: 'ci', acceptByLocale: { gu: ['પાંચ'] } },
          { id: 'two', accept: ['x'], match: 'ci' },
        ],
      },
      answer: { format: 'blanks', values: { one: 'seven', two: 'x' } },
      max: 2, score: 1, status: 'graded',
    },
    {
      // A key written before 0034 has no acceptByLocale at all, and must grade
      // exactly as it did — the union is additive by construction.
      name: 'a key with no translations grades as it always did', content: BLANKS,
      key: blanksKey({ accept: ['five'], match: 'ci' }, { accept: ['six'], match: 'ci' }),
      answer: { format: 'blanks', values: { one: 'five', two: 'six' } },
      max: 4, score: 4, status: 'graded',
    },
    {
      /**
       * The pre-existing bug the union would have amplified: 0027 abandoned
       * the whole blank on one invalid pattern, so a single bad Gujarati regex
       * would have sent EVERY candidate's blank to manual review.
       */
      name: 'one invalid regex no longer condemns a blank that matched another', content: BLANKS,
      key: {
        format: 'blanks', partialCredit: true,
        blanks: [
          { id: 'one', accept: ['[unclosed', '5|five'], match: 'regex' },
          { id: 'two', accept: ['x'], match: 'ci' },
        ],
      },
      answer: { format: 'blanks', values: { one: 'five', two: 'x' } },
      max: 2, score: 2, status: 'graded',
    },
  ]],

  ['manual formats and data faults', [
    { name: 'an essay is not auto-graded', content: { format: 'text_long' },
      key: { format: 'text_long', rubric: [{ id: 'r1', label: 'x', max: 2 }] },
      answer: { format: 'text_long', text: 'an answer' }, max: 5, score: 0, status: 'not_applicable' },
    { name: 'a short text answer is not auto-graded', content: { format: 'text_short' },
      key: { format: 'text_short' }, answer: { format: 'text_short', text: 'x' },
      max: 5, score: 0, status: 'not_applicable' },
    // A data fault is not the candidate's fault, so it must not score them zero.
    { name: 'an answer in the wrong format goes to a human, not to zero', content: SINGLE,
      key: { format: 'choice_single', correct: 'b' },
      answer: { format: 'boolean', value: true },
      max: 3, negative: 1, score: 0, status: 'needs_review', review: true },
    { name: 'a question whose content disagrees with its key goes to a human', content: { format: 'boolean' },
      key: { format: 'choice_single', correct: 'b' },
      answer: { format: 'choice_single', choice: 'b' },
      max: 3, score: 0, status: 'needs_review', review: true },
  ]],
]

describeDb('auto-grading', () => {
  let db: Client

  beforeAll(async () => { db = await connect() })
  afterAll(async () => { await db.end() })

  async function grade(c: Expectation) {
    return asOwner(db, async () => {
      const { rows } = await db.query(
        'select * from public.grade_answer($1::jsonb, $2::jsonb, $3::jsonb, $4::numeric, $5::numeric)',
        [JSON.stringify(c.content), JSON.stringify(c.key),
         c.answer === null ? null : JSON.stringify(c.answer), c.max, c.negative ?? 0],
      )
      return rows[0]
    })
  }

  for (const [group, cases] of GROUPS) {
    describe(group, () => {
      for (const c of cases) {
        it(c.name, async () => {
          const r = await grade(c)
          expect(Number(r.score)).toBe(c.score)
          expect(r.status).toBe(c.status)
          expect(r.needs_review).toBe(c.review ?? false)
        })
      }
    })
  }

  describe('the breakdown shown to an evaluator', () => {
    it('names which blanks were wrong without revealing the expected value', async () => {
      const r = await grade({
        name: '', content: BLANKS,
        key: blanksKey({ accept: ['five'], match: 'ci' }, { accept: ['sixty three'], match: 'ci' }),
        answer: { format: 'blanks', values: { one: 'five', two: 'nope' } },
        max: 4, score: 2, status: 'graded',
      })

      expect(r.detail.correctCount).toBe(1)
      expect(r.detail.total).toBe(2)
      expect(r.detail.blanks).toEqual([
        { id: 'one', submitted: 'five', correct: true, review: false },
        { id: 'two', submitted: 'nope', correct: false, review: false },
      ])

      // The breakdown is destined for a candidate's results screen in M5. If it
      // carried the accepted values it would hand over the answer key for every
      // question they got wrong.
      expect(JSON.stringify(r.detail)).not.toContain('sixty three')
    })
  })

  /**
   * Registry conformance, carried over from the unit suite when the grader
   * moved into the database.
   *
   * This is the only test that crosses the boundary: the sample comes from the
   * TypeScript registry a chef authors against, and it is marked by the SQL
   * grader that will score it in production. A format whose sample key does not
   * actually match its sample content passes every other test in the codebase
   * and fails here.
   */
  describe('every format grades its own sample', () => {
    /** The fully-correct answer for a sample, per format. */
    function correctAnswerFor(format: string, sampleKey: unknown) {
      // The registry's key type is a union across all nine formats; each branch
      // below already knows which member it is holding.
      const key = sampleKey as {
        correct?: unknown
        blanks?: { id: string; accept: string[] }[]
      }
      switch (format) {
        case 'choice_single': return { format, choice: key.correct }
        case 'choice_multi':  return { format, choices: key.correct }
        case 'boolean':       return { format, value: key.correct }
        case 'blanks': {
          const values: Record<string, string> = {}
          for (const b of key.blanks ?? []) values[b.id] = b.accept[0]
          return { format, values }
        }
        case 'pairs': return { format, mapping: key.correct }
        case 'order': return { format, order: key.correct }
        default:      return null
      }
    }

    for (const format of RESPONSE_FORMATS) {
      const def = FORMAT_REGISTRY[format]

      it(`${format}: sample self-grades to full marks`, async () => {
        const { content, key } = def.sample()

        if (!def.autoGradable) {
          const r = await grade({
            name: '', content, key, answer: def.emptyAnswer(),
            max: 10, score: 0, status: 'not_applicable',
          })
          expect(r.status).toBe('not_applicable')
          return
        }

        const r = await grade({
          name: '', content, key, answer: correctAnswerFor(format, key),
          max: 10, negative: 2, score: 10, status: 'graded',
        })
        expect(Number(r.score), `${format} sample did not self-grade to full marks`).toBe(10)
      })

      it(`${format}: an empty answer scores zero without penalty`, async () => {
        const { content, key } = def.sample()
        const r = await grade({
          name: '', content, key, answer: def.emptyAnswer(),
          max: 10, negative: 2, score: 0, status: 'graded',
        })
        expect(Number(r.score)).toBe(0)
      })
    }
  })

  describe('reachability', () => {
    it('is not callable by a signed-in employee', async () => {
      // The grader takes the key as an argument, so it is not an oracle — but
      // it is internal machinery and nothing outside the database should be
      // able to invoke it. Same rule as every other internal function (0020).
      await expect(
        asUser(db, employee('aaaaeeee-eeee-eeee-eeee-eeeeeeeeeeee'), () =>
          db.query(
            "select * from public.grade_answer('{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 1, 0)",
          ),
        ),
      ).rejects.toThrow(/permission denied/i)
    })
  })
})
