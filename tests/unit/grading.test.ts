import { describe, it, expect } from 'vitest'
import { gradeAnswer, editDistance, isAutoGradableFormat } from '@/lib/questions/grading'
import type { QuestionContent, AnswerKey, AnswerPayload } from '@/lib/questions/schemas'
import { RESPONSE_FORMATS } from '@/lib/questions/schemas'

/**
 * Grading tests — the suite that matters most.
 *
 * A bug here does not throw. It produces a plausible number that a chef signs
 * off and that lands in someone's competency record. Every format is exercised
 * across correct / incorrect / partial / empty / malformed.
 */

const opts = { maxScore: 10, negativeMarks: 2 }

const choice = (id: string) => ({ id, text: id })

describe('choice_single', () => {
  const content: QuestionContent = {
    format: 'choice_single',
    choices: [choice('a'), choice('b'), choice('c')],
  }
  const key: AnswerKey = { format: 'choice_single', correct: 'b' }

  it('awards full marks for the correct option', () => {
    const r = gradeAnswer(content, key, { format: 'choice_single', choice: 'b' }, opts)
    expect(r).toMatchObject({ score: 10, status: 'graded' })
  })

  it('applies negative marking for a wrong option', () => {
    const r = gradeAnswer(content, key, { format: 'choice_single', choice: 'a' }, opts)
    expect(r.score).toBe(-2)
  })

  it('scores zero — never negative — when skipped', () => {
    // Penalising a skip makes guessing strictly better than admitting
    // ignorance, which inverts what the exam is measuring.
    const r = gradeAnswer(content, key, { format: 'choice_single', choice: null }, opts)
    expect(r.score).toBe(0)
    expect(r.detail).toMatchObject({ answered: false })
  })

  it('scores zero when the answer is absent entirely', () => {
    expect(gradeAnswer(content, key, null, opts).score).toBe(0)
  })

  it('does not apply negative marks when none are configured', () => {
    const r = gradeAnswer(content, key, { format: 'choice_single', choice: 'a' }, { maxScore: 10 })
    expect(r.score).toBe(0)
  })
})

describe('choice_multi', () => {
  const content: QuestionContent = {
    format: 'choice_multi',
    choices: [choice('a'), choice('b'), choice('c'), choice('d')],
  }
  const key: AnswerKey = { format: 'choice_multi', correct: ['a', 'b'], partialCredit: true }

  it('awards full marks for exactly the correct set', () => {
    const r = gradeAnswer(content, key, { format: 'choice_multi', choices: ['a', 'b'] }, opts)
    expect(r.score).toBe(10)
    expect(r.detail).toMatchObject({ correct: true })
  })

  it('gives half marks for one of two correct', () => {
    const r = gradeAnswer(content, key, { format: 'choice_multi', choices: ['a'] }, opts)
    expect(r.score).toBe(5)
  })

  it('penalises incorrect selections', () => {
    // 1 of 2 right (+0.5), 1 of 2 wrong options chosen (−0.5) → 0.
    const r = gradeAnswer(content, key, { format: 'choice_multi', choices: ['a', 'c'] }, opts)
    expect(r.score).toBe(0)
  })

  it('scores selecting everything at zero, not full marks', () => {
    // Without penalising wrong picks, "tick every box" is a perfect strategy
    // and the question measures nothing.
    const r = gradeAnswer(content, key, { format: 'choice_multi', choices: ['a', 'b', 'c', 'd'] }, opts)
    expect(r.score).toBe(0)
  })

  it('never returns a negative score under partial credit', () => {
    const r = gradeAnswer(content, key, { format: 'choice_multi', choices: ['c', 'd'] }, opts)
    expect(r.score).toBe(0)
  })

  it('is all-or-nothing when partial credit is off', () => {
    const strict: AnswerKey = { format: 'choice_multi', correct: ['a', 'b'], partialCredit: false }
    expect(gradeAnswer(content, strict, { format: 'choice_multi', choices: ['a'] }, opts).score).toBe(-2)
    expect(gradeAnswer(content, strict, { format: 'choice_multi', choices: ['a', 'b'] }, opts).score).toBe(10)
  })

  it('treats an empty selection as unanswered', () => {
    const r = gradeAnswer(content, key, { format: 'choice_multi', choices: [] }, opts)
    expect(r.score).toBe(0)
    expect(r.detail).toMatchObject({ answered: false })
  })

  it('handles a key where every option is correct without dividing by zero', () => {
    const all: AnswerKey = { format: 'choice_multi', correct: ['a', 'b', 'c', 'd'], partialCredit: true }
    const r = gradeAnswer(content, all, { format: 'choice_multi', choices: ['a', 'b'] }, opts)
    expect(Number.isFinite(r.score)).toBe(true)
    expect(r.score).toBe(5)
  })
})

describe('boolean', () => {
  const content: QuestionContent = { format: 'boolean' }
  const key: AnswerKey = { format: 'boolean', correct: true }

  it('marks a matching value correct', () => {
    expect(gradeAnswer(content, key, { format: 'boolean', value: true }, opts).score).toBe(10)
  })

  it('marks a mismatched value incorrect', () => {
    expect(gradeAnswer(content, key, { format: 'boolean', value: false }, opts).score).toBe(-2)
  })

  it('distinguishes false from unanswered', () => {
    // `false` is a real answer; null is a skip. Conflating them would penalise
    // students who answered.
    expect(gradeAnswer(content, key, { format: 'boolean', value: null }, opts).score).toBe(0)
  })
})

describe('blanks', () => {
  const content: QuestionContent = {
    format: 'blanks',
    template: 'Cook chicken to {{temp}}°C for {{mins}} minutes.',
    blanks: [{ id: 'temp' }, { id: 'mins' }],
  }

  const ciKey: AnswerKey = {
    format: 'blanks',
    partialCredit: true,
    blanks: [
      { id: 'temp', accept: ['74', 'seventy four'], match: 'ci' },
      { id: 'mins', accept: ['20'], match: 'ci' },
    ],
  }

  it('awards full marks for all blanks correct', () => {
    const a: AnswerPayload = { format: 'blanks', values: { temp: '74', mins: '20' } }
    expect(gradeAnswer(content, ciKey, a, opts).score).toBe(10)
  })

  it('gives partial credit for one of two', () => {
    const a: AnswerPayload = { format: 'blanks', values: { temp: '74', mins: '99' } }
    expect(gradeAnswer(content, ciKey, a, opts).score).toBe(5)
  })

  it('ignores case and surrounding whitespace', () => {
    // Trailing whitespace is the most common false negative in any
    // fill-in-the-blank system.
    const a: AnswerPayload = { format: 'blanks', values: { temp: '  Seventy Four  ', mins: '20' } }
    expect(gradeAnswer(content, ciKey, a, opts).score).toBe(10)
  })

  it('collapses internal whitespace', () => {
    const a: AnswerPayload = { format: 'blanks', values: { temp: 'seventy    four', mins: '20' } }
    expect(gradeAnswer(content, ciKey, a, opts).score).toBe(10)
  })

  it('treats all-blank input as unanswered', () => {
    const a: AnswerPayload = { format: 'blanks', values: { temp: '', mins: '   ' } }
    const r = gradeAnswer(content, ciKey, a, opts)
    expect(r.score).toBe(0)
    expect(r.detail).toMatchObject({ answered: false })
  })

  it('treats a missing blank key as wrong, not a crash', () => {
    const a: AnswerPayload = { format: 'blanks', values: { temp: '74' } }
    expect(gradeAnswer(content, ciKey, a, opts).score).toBe(5)
  })

  describe('exact matching', () => {
    const key: AnswerKey = {
      format: 'blanks',
      partialCredit: true,
      blanks: [{ id: 'temp', accept: ['74'], match: 'exact' }, { id: 'mins', accept: ['20'], match: 'exact' }],
    }
    it('rejects a case difference', () => {
      const a: AnswerPayload = { format: 'blanks', values: { temp: '74', mins: ' 20' } }
      expect(gradeAnswer(content, key, a, opts).score).toBe(5)
    })
  })

  describe('fuzzy matching', () => {
    const key: AnswerKey = {
      format: 'blanks',
      partialCredit: true,
      blanks: [
        { id: 'temp', accept: ['seventy'], match: 'fuzzy', tolerance: 1 },
        { id: 'mins', accept: ['twenty'], match: 'fuzzy', tolerance: 1 },
      ],
    }

    it('credits a one-character typo but flags it for review', () => {
      // Across four languages a near-miss is far more often a spelling variant
      // than a wrong answer, so it is credited — and surfaced to a human.
      const a: AnswerPayload = { format: 'blanks', values: { temp: 'seventyy', mins: 'twenty' } }
      const r = gradeAnswer(content, key, a, opts)
      expect(r.score).toBe(10)
      expect(r.status).toBe('needs_review')
    })

    it('does not flag an exact match', () => {
      const a: AnswerPayload = { format: 'blanks', values: { temp: 'seventy', mins: 'twenty' } }
      expect(gradeAnswer(content, key, a, opts).status).toBe('graded')
    })

    it('refuses to fuzz short words', () => {
      // Distance 1 from "rib" reaches "rub" and "ribs" — different answers.
      const shortKey: AnswerKey = {
        format: 'blanks',
        partialCredit: true,
        blanks: [{ id: 'temp', accept: ['rib'], match: 'fuzzy', tolerance: 1 }],
      }
      const shortContent: QuestionContent = {
        format: 'blanks',
        template: 'The cut is {{temp}}.',
        blanks: [{ id: 'temp' }],
      }
      const a: AnswerPayload = { format: 'blanks', values: { temp: 'rub' } }
      expect(gradeAnswer(shortContent, shortKey, a, opts).score).toBe(0)
    })
  })

  describe('regex matching', () => {
    const rxContent: QuestionContent = {
      format: 'blanks',
      template: 'Temperature: {{temp}}',
      blanks: [{ id: 'temp' }],
    }

    it('anchors the pattern', () => {
      // Unanchored /74/ would accept "not 74", the opposite of the answer.
      const key: AnswerKey = {
        format: 'blanks',
        partialCredit: true,
        blanks: [{ id: 'temp', accept: ['\\d{2}'], match: 'regex' }],
      }
      expect(gradeAnswer(rxContent, key, { format: 'blanks', values: { temp: '74' } }, opts).score).toBe(10)
      expect(gradeAnswer(rxContent, key, { format: 'blanks', values: { temp: 'not 74' } }, opts).score).toBe(0)
    })

    it('sends an invalid pattern to review rather than failing the candidate', () => {
      const key: AnswerKey = {
        format: 'blanks',
        partialCredit: true,
        blanks: [{ id: 'temp', accept: ['1(80'], match: 'regex' }],
      }
      const r = gradeAnswer(rxContent, key, { format: 'blanks', values: { temp: '180' } }, opts)
      expect(r.status).toBe('needs_review')
    })
  })

  it('is all-or-nothing when partial credit is off', () => {
    const strict: AnswerKey = {
      format: 'blanks',
      partialCredit: false,
      blanks: [
        { id: 'temp', accept: ['74'], match: 'ci' },
        { id: 'mins', accept: ['20'], match: 'ci' },
      ],
    }
    const a: AnswerPayload = { format: 'blanks', values: { temp: '74', mins: '99' } }
    expect(gradeAnswer(content, strict, a, opts).score).toBe(-2)
  })
})

describe('pairs', () => {
  const content: QuestionContent = {
    format: 'pairs',
    left: [choice('l1'), choice('l2')],
    right: [choice('r1'), choice('r2')],
    hasDistractors: false,
  }
  const key: AnswerKey = { format: 'pairs', correct: { l1: 'r1', l2: 'r2' }, partialCredit: true }

  it('awards full marks for all pairs matched', () => {
    const a: AnswerPayload = { format: 'pairs', mapping: { l1: 'r1', l2: 'r2' } }
    expect(gradeAnswer(content, key, a, opts).score).toBe(10)
  })

  it('gives partial credit for one of two', () => {
    const a: AnswerPayload = { format: 'pairs', mapping: { l1: 'r1', l2: 'r1' } }
    expect(gradeAnswer(content, key, a, opts).score).toBe(5)
  })

  it('treats an empty mapping as unanswered', () => {
    const a: AnswerPayload = { format: 'pairs', mapping: {} }
    expect(gradeAnswer(content, key, a, opts).detail).toMatchObject({ answered: false })
  })

  it('reports which pairs were wrong', () => {
    const a: AnswerPayload = { format: 'pairs', mapping: { l1: 'r2', l2: 'r2' } }
    const detail = gradeAnswer(content, key, a, opts).detail as { pairs: Array<{ left: string; correct: boolean }> }
    expect(detail.pairs.find((p) => p.left === 'l1')?.correct).toBe(false)
    expect(detail.pairs.find((p) => p.left === 'l2')?.correct).toBe(true)
  })
})

describe('order', () => {
  const content: QuestionContent = {
    format: 'order',
    items: [choice('s1'), choice('s2'), choice('s3'), choice('s4')],
  }

  describe('exact scoring', () => {
    const key: AnswerKey = { format: 'order', correct: ['s1', 's2', 's3', 's4'], scoring: 'exact' }

    it('awards full marks for the exact order', () => {
      const a: AnswerPayload = { format: 'order', order: ['s1', 's2', 's3', 's4'] }
      expect(gradeAnswer(content, key, a, opts).score).toBe(10)
    })

    it('gives nothing for a near-miss', () => {
      const a: AnswerPayload = { format: 'order', order: ['s1', 's2', 's4', 's3'] }
      expect(gradeAnswer(content, key, a, opts).score).toBe(-2)
    })
  })

  describe('adjacent scoring', () => {
    const key: AnswerKey = { format: 'order', correct: ['s1', 's2', 's3', 's4'], scoring: 'adjacent' }

    it('credits correctly-ordered adjacent pairs', () => {
      // Right for procedures: the first steps being in order is worth something
      // even when two later steps swap.
      const a: AnswerPayload = { format: 'order', order: ['s1', 's2', 's4', 's3'] }
      const r = gradeAnswer(content, key, a, opts)
      expect(r.score).toBeGreaterThan(0)
      expect(r.score).toBeLessThan(10)
    })

    it('still awards full marks for a perfect order', () => {
      const a: AnswerPayload = { format: 'order', order: ['s1', 's2', 's3', 's4'] }
      expect(gradeAnswer(content, key, a, opts).score).toBe(10)
    })

    it('gives zero for a fully reversed order', () => {
      const a: AnswerPayload = { format: 'order', order: ['s4', 's3', 's2', 's1'] }
      expect(gradeAnswer(content, key, a, opts).score).toBe(0)
    })
  })

  describe('kendall scoring', () => {
    const key: AnswerKey = { format: 'order', correct: ['s1', 's2', 's3', 's4'], scoring: 'kendall' }

    it('awards full marks for a perfect order', () => {
      const a: AnswerPayload = { format: 'order', order: ['s1', 's2', 's3', 's4'] }
      expect(gradeAnswer(content, key, a, opts).score).toBe(10)
    })

    it('gives zero for a fully reversed order', () => {
      const a: AnswerPayload = { format: 'order', order: ['s4', 's3', 's2', 's1'] }
      expect(gradeAnswer(content, key, a, opts).score).toBe(0)
    })

    it('scores a mostly-right order generously', () => {
      const a: AnswerPayload = { format: 'order', order: ['s1', 's2', 's4', 's3'] }
      const r = gradeAnswer(content, key, a, opts)
      expect(r.score).toBeGreaterThan(7)
      expect(r.score).toBeLessThan(10)
    })
  })

  it('treats an empty order as unanswered', () => {
    const key: AnswerKey = { format: 'order', correct: ['s1', 's2'], scoring: 'exact' }
    expect(gradeAnswer(content, key, { format: 'order', order: [] }, opts).detail).toMatchObject({ answered: false })
  })
})

describe('manual formats', () => {
  it.each([
    ['text_short', { format: 'text_short', keywords: [] }],
    ['text_long', { format: 'text_long', rubric: [] }],
    ['evaluator_only', { format: 'evaluator_only', rubric: [{ id: 'c', label: 'x', max: 5 }] }],
  ] as const)('returns not_applicable for %s', (fmt, key) => {
    const content = { format: fmt } as QuestionContent
    const answer = { format: fmt, text: 'anything', attachments: [] } as unknown as AnswerPayload
    const r = gradeAnswer(content, key as AnswerKey, answer, opts)
    expect(r).toMatchObject({ score: 0, status: 'not_applicable' })
  })
})

describe('malformed input', () => {
  it('flags a format mismatch for review rather than failing the candidate', () => {
    // An authoring or data fault must never be charged to the student.
    const content: QuestionContent = { format: 'boolean' }
    const key: AnswerKey = { format: 'boolean', correct: true }
    const answer = { format: 'choice_single', choice: 'a' } as AnswerPayload
    const r = gradeAnswer(content, key, answer, opts)
    expect(r.status).toBe('needs_review')
    expect(r.score).toBe(0)
  })
})

describe('editDistance', () => {
  it('is zero for identical strings', () => expect(editDistance('abc', 'abc')).toBe(0))
  it('counts a substitution', () => expect(editDistance('abc', 'abd')).toBe(1))
  it('counts an insertion', () => expect(editDistance('abc', 'abcd')).toBe(1))
  it('counts a deletion', () => expect(editDistance('abcd', 'abc')).toBe(1))
  it('handles an empty string', () => expect(editDistance('', 'abc')).toBe(3))
  it('handles both empty', () => expect(editDistance('', '')).toBe(0))
  it('is symmetric', () => expect(editDistance('kitten', 'sitting')).toBe(editDistance('sitting', 'kitten')))
  it('matches the known kitten/sitting distance', () => expect(editDistance('kitten', 'sitting')).toBe(3))
})

describe('auto-gradability', () => {
  it('marks exactly the six machine-gradable formats', () => {
    const auto = RESPONSE_FORMATS.filter(isAutoGradableFormat)
    expect(auto).toEqual(['choice_single', 'choice_multi', 'boolean', 'blanks', 'pairs', 'order'])
  })
})
