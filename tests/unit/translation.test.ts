import { describe, it, expect } from 'vitest'
import {
  mergeTranslation,
  translationIssues,
  emptyTranslation,
  placeholdersIn,
  translationContentSchema,
} from '@/lib/questions/translation'
import type { RenderableContent } from '@/components/questions/types'

/**
 * The merge is the load-bearing function here: 0033's delivery path calls it to
 * render a candidate's paper in their language, and the workbench calls it to
 * preview. One implementation, so the preview cannot lie about the paper.
 */

const MCQ = {
  format: 'choice_single',
  choices: [
    { id: 'a', text: 'Seventy four' },
    { id: 'b', text: 'Sixty three' },
  ],
} as RenderableContent

const BLANKS = {
  format: 'blanks',
  template: 'Between {{low}} and {{high}} degrees.',
  blanks: [{ id: 'low', label: 'lower' }, { id: 'high' }],
} as RenderableContent

const PAIRS = {
  format: 'pairs',
  left: [{ id: 'l1', text: 'Dashi' }],
  right: [{ id: 'r1', text: 'Japanese' }],
  hasDistractors: false,
} as RenderableContent

const ORDER = {
  format: 'order',
  items: [{ id: 'i1', text: 'Wash' }, { id: 'i2', text: 'Sanitise' }],
} as RenderableContent

describe('mergeTranslation', () => {
  it('replaces option text and keeps the ids', () => {
    const merged = mergeTranslation(MCQ, { choices: { a: 'ચુમ્મોતેર', b: 'ત્રેસઠ' } }) as {
      choices: Array<{ id: string; text: string }>
    }
    expect(merged.choices).toEqual([
      { id: 'a', text: 'ચુમ્મોતેર' },
      { id: 'b', text: 'ત્રેસઠ' },
    ])
  })

  /**
   * The whole reason this is not a jsonb `||`: the base carries an array and
   * the translation a map, so a shallow merge would replace the array with the
   * object and every renderer would break on `.map`.
   */
  it('returns an array, not the translation map', () => {
    const merged = mergeTranslation(MCQ, { choices: { a: 'ક' } }) as { choices: unknown }
    expect(Array.isArray(merged.choices)).toBe(true)
  })

  it('leaves untranslated options in the base language', () => {
    const merged = mergeTranslation(MCQ, { choices: { a: 'ક' } }) as {
      choices: Array<{ text: string }>
    }
    // A half-finished translation reads as a mixture, not as gaps.
    expect(merged.choices[0].text).toBe('ક')
    expect(merged.choices[1].text).toBe('Sixty three')
  })

  it('returns the base untouched when there is no translation', () => {
    expect(mergeTranslation(MCQ, null)).toBe(MCQ)
    expect(mergeTranslation(MCQ, undefined)).toBe(MCQ)
  })

  it('does not mutate the base', () => {
    const before = JSON.stringify(MCQ)
    mergeTranslation(MCQ, { choices: { a: 'ક' } })
    expect(JSON.stringify(MCQ)).toBe(before)
  })

  it('translates both sides of a pair', () => {
    const merged = mergeTranslation(PAIRS, { left: { l1: 'દાશી' }, right: { r1: 'જાપાની' } }) as {
      left: Array<{ text: string }>
      right: Array<{ text: string }>
    }
    expect(merged.left[0].text).toBe('દાશી')
    expect(merged.right[0].text).toBe('જાપાની')
  })

  it('translates ordering items', () => {
    const merged = mergeTranslation(ORDER, { items: { i1: 'ધોવું' } }) as {
      items: Array<{ text: string }>
    }
    expect(merged.items[0].text).toBe('ધોવું')
    expect(merged.items[1].text).toBe('Sanitise')
  })

  it('replaces a blanks template and its labels', () => {
    const merged = mergeTranslation(BLANKS, {
      template: '{{low}} થી {{high}} ડિગ્રી વચ્ચે.',
      blankLabels: { low: 'નીચું' },
    }) as { template: string; blanks: Array<{ id: string; label?: string }> }

    expect(merged.template).toContain('{{high}}')
    expect(merged.blanks[0].label).toBe('નીચું')
    expect(merged.blanks[1].label).toBeUndefined()
  })

  it('ignores an id the question does not have', () => {
    const merged = mergeTranslation(MCQ, { choices: { zz: 'ghost' } }) as {
      choices: Array<{ text: string }>
    }
    expect(merged.choices.map((c) => c.text)).toEqual(['Seventy four', 'Sixty three'])
  })

  it.each(['boolean', 'text_short', 'text_long'])(
    'returns %s content unchanged — there is nothing in it to translate',
    (format) => {
      const base = { format } as RenderableContent
      expect(mergeTranslation(base, { choices: { a: 'x' } })).toBe(base)
    },
  )
})

describe('translationIssues', () => {
  it('is silent on a correct translation', () => {
    expect(translationIssues(MCQ, { choices: { a: 'ક', b: 'ખ' } })).toEqual([])
  })

  it('names an id the question does not have', () => {
    const issues = translationIssues(MCQ, { choices: { zz: 'ghost' } })
    expect(issues).toHaveLength(1)
    expect(issues[0].message).toContain('"zz"')
  })

  /**
   * A template that loses {{high}} renders one input where the key grades two:
   * the candidate cannot answer a blank they are marked on, and the grader
   * scores it wrong with no signal.
   */
  it('catches a dropped placeholder', () => {
    const issues = translationIssues(BLANKS, { template: 'ફક્ત {{low}} ડિગ્રી.' })
    expect(issues).toHaveLength(1)
    expect(issues[0].path).toBe('template')
    expect(issues[0].message).toContain('high')
  })

  it('catches an invented placeholder', () => {
    const issues = translationIssues(BLANKS, {
      template: '{{low}} {{high}} {{extra}}',
    })
    expect(issues).toHaveLength(1)
  })

  it('accepts a template whose placeholders are reordered', () => {
    // Word order differs between languages; only the SET has to match.
    expect(
      translationIssues(BLANKS, { template: '{{high}} થી {{low}} સુધી.' }),
    ).toEqual([])
  })
})

describe('placeholdersIn', () => {
  it('deduplicates and sorts', () => {
    expect(placeholdersIn('{{b}} {{a}} {{b}}')).toEqual(['a', 'b'])
  })

  it('finds none in prose', () => {
    expect(placeholdersIn('no blanks here')).toEqual([])
  })
})

describe('emptyTranslation', () => {
  it.each([
    ['choice_single', 'choices'],
    ['pairs', 'left'],
    ['order', 'items'],
    ['blanks', 'template'],
    ['evaluator_only', 'instructions'],
  ])('shapes %s around its %s', (format, key) => {
    const empty = emptyTranslation({ format } as never) as Record<string, unknown>
    expect(key in empty).toBe(true)
  })

  it('gives boolean nothing to fill in', () => {
    expect(emptyTranslation({ format: 'boolean' } as never)).toEqual({})
  })
})

describe('translationContentSchema', () => {
  it('accepts display strings', () => {
    expect(translationContentSchema.safeParse({ choices: { a: 'क' } }).success).toBe(true)
  })

  /**
   * Mirrors 0032's CHECK. The database is the authority — this exists so the
   * workbench can say what is wrong without a round trip.
   */
  it.each([
    ['a non-string leaf', { choices: { a: 123 } }],
    ['a nested object', { choices: { a: { text: 'x' } } }],
    ['an unknown key', { correct: 'a' }],
  ])('refuses %s', (_label, content) => {
    expect(translationContentSchema.safeParse(content).success).toBe(false)
  })
})
