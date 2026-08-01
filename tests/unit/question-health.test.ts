import { describe, it, expect } from 'vitest'
import {
  EXPECTED_TRANSLATION_LOCALES,
  QUESTION_HEALTH_FLAGS,
  questionHealth,
  type QuestionHealthInput,
} from '../../src/lib/questions/health'

/**
 * Question health — completeness, not quality.
 *
 * The assertion that matters most is the negative one: a complete question must
 * produce NO flags. Without it, every test here passes against a function that
 * returns all four flags for everything, and the bank would render a wall of
 * badges that people learn to ignore within a day.
 */

const complete: QuestionHealthInput = {
  category_id: 'cat-1',
  bloom_level: 'analyze',
  hasAnswerKey: true,
  translatedLocales: [...EXPECTED_TRANSLATION_LOCALES],
}

const flagsOf = (input: Partial<QuestionHealthInput>) =>
  questionHealth({ ...complete, ...input }).map((h) => h.flag)

describe('questionHealth', () => {
  it('says nothing about a complete question', () => {
    expect(questionHealth(complete)).toEqual([])
  })

  it('flags a missing answer key', () => {
    expect(flagsOf({ hasAnswerKey: false })).toContain('no-answer-key')
  })

  it('flags a missing category', () => {
    expect(flagsOf({ category_id: null })).toContain('no-category')
  })

  it('flags a missing Bloom level', () => {
    expect(flagsOf({ bloom_level: null })).toContain('no-bloom')
  })

  it('flags the locales with no published translation, and names them', () => {
    const health = questionHealth({ ...complete, translatedLocales: ['hi'] })
    const untranslated = health.find((h) => h.flag === 'untranslated')
    expect(untranslated).toBeDefined()
    expect(untranslated?.detail).toEqual(['gu'])
  })

  it('does not flag English, which is the question itself', () => {
    // questions.stem IS the English text — it is not a translation of anything,
    // and expecting an `en` row in question_translations would flag every
    // question in the bank.
    expect(EXPECTED_TRANSLATION_LOCALES).not.toContain('en')
    expect(flagsOf({ translatedLocales: [...EXPECTED_TRANSLATION_LOCALES] })).toEqual([])
  })

  /**
   * ┌─────────────────────────────────────────────────────────────────────────┐
   * │ THE REGRESSION THIS PINS.                                               │
   * │                                                                         │
   * │ "Never used" was going to be a flag until usage_count turned out to     │
   * │ have exactly one writer — publish_exam, FIXED papers only, joined       │
   * │ through exam_questions. Rule-based exams draw at attempt start and      │
   * │ never touch it, and this bank is built around rule-based selection. So  │
   * │ the flag would have fired on every question in a company that delivers  │
   * │ every exam by rules, which is most of them.                             │
   * │                                                                         │
   * │ usage_count is not even an input to this function. That is on purpose,  │
   * │ and this test is what says so out loud.                                 │
   * └─────────────────────────────────────────────────────────────────────────┘
   */
  it('says nothing about a question that has never been on a fixed paper', () => {
    expect('usage_count' in complete).toBe(false)
    expect(questionHealth(complete)).toEqual([])
  })

  it('reports every problem at once, not just the first', () => {
    const flags = flagsOf({
      category_id: null,
      bloom_level: null,
      hasAnswerKey: false,
      translatedLocales: [],
    })
    expect([...flags].sort()).toEqual([...QUESTION_HEALTH_FLAGS].sort())
  })

  it('leads with the answer key, which is the one that grades people wrong', () => {
    const flags = flagsOf({ category_id: null, hasAnswerKey: false })
    expect(flags[0]).toBe('no-answer-key')
  })
})
