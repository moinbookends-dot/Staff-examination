import { describe, it, expect } from 'vitest'
import {
  questionContentSchema,
  answerKeySchema,
  answerPayloadSchema,
  validateQuestion,
  isAutoGradable,
  formatAllowedForType,
  RESPONSE_FORMATS,
  QUESTION_TYPES,
  TYPE_FORMATS,
  type QuestionContent,
  type AnswerKey,
} from '@/lib/questions/schemas'

/**
 * The contract tests.
 *
 * Weighted heavily toward validateQuestion(), because that is where the
 * expensive mistakes hide: a key referencing an option id that does not exist
 * parses cleanly against both schemas and then marks every candidate wrong,
 * silently, with no error anywhere in the system.
 */

const choice = (id: string, text = id.toUpperCase()) => ({ id, text })

describe('QuestionContent', () => {
  it('accepts a valid single-choice question', () => {
    const r = questionContentSchema.safeParse({
      format: 'choice_single',
      choices: [choice('a'), choice('b'), choice('c')],
    })
    expect(r.success).toBe(true)
  })

  it('rejects a single-choice question with one option', () => {
    const r = questionContentSchema.safeParse({ format: 'choice_single', choices: [choice('a')] })
    expect(r.success).toBe(false)
  })

  it('rejects duplicate option ids', () => {
    // Duplicates would make an answer referencing that id ambiguous.
    const r = questionContentSchema.safeParse({
      format: 'choice_single',
      choices: [choice('a'), choice('a', 'Different text')],
    })
    expect(r.success).toBe(false)
  })

  it('rejects option ids with unsafe characters', () => {
    const r = questionContentSchema.safeParse({
      format: 'choice_single',
      choices: [choice('a b'), choice('c')],
    })
    expect(r.success).toBe(false)
  })

  it('applies defaults for text limits', () => {
    const short = questionContentSchema.parse({ format: 'text_short' })
    const long = questionContentSchema.parse({ format: 'text_long' })
    expect(short).toMatchObject({ maxChars: 300 })
    expect(long).toMatchObject({ maxWords: 500 })
  })

  it('accepts boolean with no payload', () => {
    expect(questionContentSchema.safeParse({ format: 'boolean' }).success).toBe(true)
  })

  it('rejects an unknown format', () => {
    expect(questionContentSchema.safeParse({ format: 'telepathy' }).success).toBe(false)
  })

  it('never carries a correct answer', () => {
    // Structural guarantee, not stylistic: content is what reaches the
    // candidate's browser. If a "correct" key were ever accepted here it would
    // be one refactor away from being served.
    const parsed = questionContentSchema.parse({
      format: 'choice_single',
      choices: [choice('a'), choice('b')],
      correct: 'a',
    })
    expect(parsed).not.toHaveProperty('correct')
  })
})

describe('AnswerKey', () => {
  it('defaults partial credit on', () => {
    const k = answerKeySchema.parse({ format: 'choice_multi', correct: ['a'] })
    expect(k).toMatchObject({ partialCredit: true })
  })

  it('requires at least one correct option for multi-select', () => {
    expect(answerKeySchema.safeParse({ format: 'choice_multi', correct: [] }).success).toBe(false)
  })

  it('requires a rubric for evaluator-only questions', () => {
    expect(answerKeySchema.safeParse({ format: 'evaluator_only', rubric: [] }).success).toBe(false)
    expect(
      answerKeySchema.safeParse({
        format: 'evaluator_only',
        rubric: [{ id: 'c1', label: 'Knife control', max: 5 }],
      }).success,
    ).toBe(true)
  })

  it('defaults blank matching to case-insensitive', () => {
    const k = answerKeySchema.parse({
      format: 'blanks',
      blanks: [{ id: 'b1', accept: ['180'] }],
    })
    expect(k).toMatchObject({ blanks: [{ match: 'ci' }] })
  })
})

describe('validateQuestion — cross-shape integrity', () => {
  it('passes a coherent single-choice question', () => {
    const content: QuestionContent = {
      format: 'choice_single',
      choices: [choice('a'), choice('b')],
    }
    const key: AnswerKey = { format: 'choice_single', correct: 'a' }
    expect(validateQuestion(content, key)).toEqual([])
  })

  it('catches a correct answer that is not among the options', () => {
    // THE headline case. Both shapes parse; the question is unanswerable.
    const content: QuestionContent = {
      format: 'choice_single',
      choices: [choice('a'), choice('b')],
    }
    const key: AnswerKey = { format: 'choice_single', correct: 'z' }
    const issues = validateQuestion(content, key)
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('not one of the options')
  })

  it('catches mismatched formats', () => {
    const content: QuestionContent = { format: 'boolean' }
    const key = { format: 'choice_single', correct: 'a' } as AnswerKey
    expect(validateQuestion(content, key)[0].message).toContain('answer key is choice_single')
  })

  it('rejects multi-select where every option is correct', () => {
    // Parses fine, scores everyone full marks, measures nothing.
    const content: QuestionContent = {
      format: 'choice_multi',
      choices: [choice('a'), choice('b')],
    }
    const key: AnswerKey = { format: 'choice_multi', correct: ['a', 'b'], partialCredit: true }
    expect(validateQuestion(content, key).some((i) => i.message.includes('cannot discriminate'))).toBe(true)
  })

  describe('blanks', () => {
    const base: QuestionContent = {
      format: 'blanks',
      template: 'Sear the steak at {{temp}} degrees for {{mins}} minutes.',
      blanks: [{ id: 'temp' }, { id: 'mins' }],
    }

    it('passes when every blank has answers and appears in the template', () => {
      const key: AnswerKey = {
        format: 'blanks',
        partialCredit: true,
        blanks: [
          { id: 'temp', accept: ['180'], match: 'ci' },
          { id: 'mins', accept: ['3'], match: 'ci' },
        ],
      }
      expect(validateQuestion(base, key)).toEqual([])
    })

    it('catches a blank with no accepted answers', () => {
      const key: AnswerKey = {
        format: 'blanks',
        partialCredit: true,
        blanks: [{ id: 'temp', accept: ['180'], match: 'ci' }],
      }
      expect(validateQuestion(base, key).some((i) => i.message.includes('no accepted answers'))).toBe(true)
    })

    it('catches a blank missing from the template', () => {
      // Candidate is never shown an input, so cannot answer, so always loses
      // the mark. Invisible unless someone sits the exam.
      const content: QuestionContent = {
        format: 'blanks',
        template: 'Sear at {{temp}} degrees.',
        blanks: [{ id: 'temp' }, { id: 'mins' }],
      }
      const key: AnswerKey = {
        format: 'blanks',
        partialCredit: true,
        blanks: [
          { id: 'temp', accept: ['180'], match: 'ci' },
          { id: 'mins', accept: ['3'], match: 'ci' },
        ],
      }
      expect(validateQuestion(content, key).some((i) => i.message.includes('does not appear in the text'))).toBe(true)
    })

    it('requires a tolerance when fuzzy matching', () => {
      const key: AnswerKey = {
        format: 'blanks',
        partialCredit: true,
        blanks: [
          { id: 'temp', accept: ['180'], match: 'fuzzy' },
          { id: 'mins', accept: ['3'], match: 'ci' },
        ],
      }
      expect(validateQuestion(base, key).some((i) => i.message.includes('no tolerance'))).toBe(true)
    })

    it('catches an invalid regular expression', () => {
      const key: AnswerKey = {
        format: 'blanks',
        partialCredit: true,
        blanks: [
          { id: 'temp', accept: ['1(80'], match: 'regex' },
          { id: 'mins', accept: ['3'], match: 'ci' },
        ],
      }
      expect(validateQuestion(base, key).some((i) => i.message.includes('invalid regular expression'))).toBe(true)
    })
  })

  describe('pairs', () => {
    it('catches an unmatched left item', () => {
      const content: QuestionContent = {
        format: 'pairs',
        left: [choice('l1'), choice('l2')],
        right: [choice('r1'), choice('r2')],
        hasDistractors: false,
      }
      const key: AnswerKey = { format: 'pairs', correct: { l1: 'r1' }, partialCredit: true }
      expect(validateQuestion(content, key).some((i) => i.message.includes('has no match'))).toBe(true)
    })

    it('catches uneven columns when distractors are off', () => {
      const content: QuestionContent = {
        format: 'pairs',
        left: [choice('l1'), choice('l2')],
        right: [choice('r1'), choice('r2'), choice('r3')],
        hasDistractors: false,
      }
      const key: AnswerKey = { format: 'pairs', correct: { l1: 'r1', l2: 'r2' }, partialCredit: true }
      expect(validateQuestion(content, key).some((i) => i.message.includes('Column sizes differ'))).toBe(true)
    })

    it('allows uneven columns when distractors are declared', () => {
      const content: QuestionContent = {
        format: 'pairs',
        left: [choice('l1'), choice('l2')],
        right: [choice('r1'), choice('r2'), choice('r3')],
        hasDistractors: true,
      }
      const key: AnswerKey = { format: 'pairs', correct: { l1: 'r1', l2: 'r2' }, partialCredit: true }
      expect(validateQuestion(content, key)).toEqual([])
    })
  })

  describe('order', () => {
    const content: QuestionContent = {
      format: 'order',
      items: [choice('s1'), choice('s2'), choice('s3')],
    }

    it('passes a complete ordering', () => {
      const key: AnswerKey = { format: 'order', correct: ['s1', 's2', 's3'], scoring: 'exact' }
      expect(validateQuestion(content, key)).toEqual([])
    })

    it('catches an incomplete ordering', () => {
      const key: AnswerKey = { format: 'order', correct: ['s1', 's2'], scoring: 'exact' }
      expect(validateQuestion(content, key).some((i) => i.message.includes('every item exactly once'))).toBe(true)
    })

    it('catches a repeated item', () => {
      const key: AnswerKey = { format: 'order', correct: ['s1', 's1', 's3'], scoring: 'exact' }
      expect(validateQuestion(content, key).some((i) => i.message.includes('repeats an item'))).toBe(true)
    })
  })
})

describe('format ↔ type mapping', () => {
  it('assigns every PRD question type at least one format', () => {
    for (const t of QUESTION_TYPES) {
      expect(TYPE_FORMATS[t].length, `${t} has no formats`).toBeGreaterThan(0)
    }
  })

  it('lets the four media types use any format', () => {
    // The whole point of splitting type from format: an image-based question is
    // still an MCQ or a short answer, not a fifteenth kind of thing.
    for (const t of ['image', 'video', 'audio', 'document'] as const) {
      expect(TYPE_FORMATS[t]).toEqual(RESPONSE_FORMATS)
    }
  })

  it('pins non-media types to a single format', () => {
    expect(formatAllowedForType('mcq_single', 'choice_single')).toBe(true)
    expect(formatAllowedForType('mcq_single', 'text_long')).toBe(false)
    expect(formatAllowedForType('viva', 'evaluator_only')).toBe(true)
  })

  it('marks exactly the three human-graded formats as manual', () => {
    const manual = RESPONSE_FORMATS.filter((f) => !isAutoGradable(f))
    expect(manual).toEqual(['text_short', 'text_long', 'evaluator_only'])
  })
})

describe('AnswerPayload', () => {
  it('accepts an unanswered single choice', () => {
    // null is a real state — the candidate skipped it. Distinct from an empty
    // string, which would sort as "answered with nothing".
    expect(answerPayloadSchema.safeParse({ format: 'choice_single', choice: null }).success).toBe(true)
  })

  it('accepts an empty multi-select', () => {
    expect(answerPayloadSchema.safeParse({ format: 'choice_multi', choices: [] }).success).toBe(true)
  })

  it('rejects a payload whose format is unknown', () => {
    expect(answerPayloadSchema.safeParse({ format: 'nope', text: 'x' }).success).toBe(false)
  })

  it('covers every response format', () => {
    // Guards against adding a format and forgetting its payload shape, which
    // would only surface when a candidate tried to answer one.
    const covered = answerPayloadSchema.options.map(
      (o) => (o.shape.format as { value: string }).value,
    )
    expect(covered.sort()).toEqual([...RESPONSE_FORMATS].sort())
  })
})

describe('schema coverage', () => {
  it('defines content and key shapes for every response format', () => {
    const contentFormats = questionContentSchema.options.map(
      (o) => (o.shape.format as { value: string }).value,
    )
    const keyFormats = answerKeySchema.options.map(
      (o) => (o.shape.format as { value: string }).value,
    )
    expect(contentFormats.sort()).toEqual([...RESPONSE_FORMATS].sort())
    expect(keyFormats.sort()).toEqual([...RESPONSE_FORMATS].sort())
  })
})
