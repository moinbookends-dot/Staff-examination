import { describe, it, expect } from 'vitest'
import {
  FORMAT_REGISTRY,
  ALL_FORMATS,
  getFormat,
  csvColumnsFor,
  allCsvColumns,
} from '@/lib/questions/registry'
import {
  RESPONSE_FORMATS,
  questionContentSchema,
  questionContentDraftSchema,
  answerKeySchema,
  answerPayloadSchema,
  validateQuestion,
  isAutoGradable,
} from '@/lib/questions/schemas'
import { gradeAnswer } from '@/lib/questions/grading'

/**
 * Registry conformance.
 *
 * These are the tests that make "add a format in one place" actually true.
 * Every assertion below is parameterised over RESPONSE_FORMATS, so adding a
 * tenth format with a missing or broken registry entry fails here rather than
 * at runtime in front of a chef.
 */

describe('registry completeness', () => {
  it('has an entry for every response format', () => {
    for (const f of RESPONSE_FORMATS) {
      expect(FORMAT_REGISTRY[f], `missing registry entry for ${f}`).toBeDefined()
    }
    expect(Object.keys(FORMAT_REGISTRY).sort()).toEqual([...RESPONSE_FORMATS].sort())
  })

  it('has no entries for formats that do not exist', () => {
    for (const key of Object.keys(FORMAT_REGISTRY)) {
      expect(RESPONSE_FORMATS).toContain(key)
    }
  })

  it('exposes every entry through ALL_FORMATS', () => {
    expect(ALL_FORMATS).toHaveLength(RESPONSE_FORMATS.length)
  })

  it('self-identifies consistently', () => {
    // A copy-paste slip where an entry keeps the previous format's key would
    // otherwise route every lookup to the wrong grader.
    for (const [key, def] of Object.entries(FORMAT_REGISTRY)) {
      expect(def.format, `${key} entry declares format "${def.format}"`).toBe(key)
    }
  })

  it('throws a useful error for an unknown format', () => {
    // @ts-expect-error deliberately invalid
    expect(() => getFormat('telepathy')).toThrow(/telepathy/)
  })
})

describe.each(RESPONSE_FORMATS)('format: %s', (format) => {
  const def = FORMAT_REGISTRY[format]

  it('declares translation keys rather than literal labels', () => {
    // Format names are shown in the authoring UI, which is translated into
    // four languages. A hard-coded English label would leak through.
    expect(def.labelKey).toMatch(/^[a-z_]+\.label$/)
    expect(def.descriptionKey).toMatch(/^[a-z_]+\.description$/)
    expect(def.labelKey.startsWith(format)).toBe(true)
  })

  it('agrees with isAutoGradable', () => {
    // The registry flag and the schema helper are consulted by different
    // layers; if they disagree, an exam's requires_manual_grading is wrong and
    // attempts either skip evaluation or wait forever for it.
    expect(def.autoGradable).toBe(isAutoGradable(format))
  })

  it('produces empty content that parses as a DRAFT', () => {
    // "New question" must open cleanly. It is deliberately incomplete — blank
    // option text, empty arrays — so it is validated against the draft schema.
    // Validating it strictly would cover the form in errors before the chef
    // types anything, which teaches people to ignore validation.
    const parsed = questionContentDraftSchema.safeParse(def.emptyContent())
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
  })

  it('produces empty content that is NOT publishable', () => {
    // The other half of the contract: a blank question must never pass the
    // strict gate. If it does, someone can activate an empty question.
    if (['boolean', 'text_short', 'text_long', 'evaluator_only'].includes(format)) {
      // These carry no author-supplied collections, so an empty one is
      // structurally complete — the stem alone makes it a real question.
      return
    }
    expect(questionContentSchema.safeParse(def.emptyContent()).success).toBe(false)
  })

  it('produces an empty answer that parses', () => {
    const parsed = answerPayloadSchema.safeParse(def.emptyAnswer())
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true)
  })

  it('produces a sample that parses and validates', () => {
    const { content, key } = def.sample()
    expect(questionContentSchema.safeParse(content).success).toBe(true)
    expect(answerKeySchema.safeParse(key).success).toBe(true)
    // Samples feed import templates and AI few-shot prompts. A sample that
    // fails cross-shape validation would teach both the wrong shape.
    expect(validateQuestion(content, key)).toEqual([])
  })

  it('round-trips its sample through CSV', () => {
    // The property that makes bulk import and export trustworthy: export then
    // re-import must reproduce the question.
    const { content, key } = def.sample()
    const row = def.serialize(content, key)
    const back = def.deserialize(row)

    expect('error' in back ? back.error : null).toBeNull()
    if ('error' in back) return

    expect(questionContentSchema.safeParse(back.content).success).toBe(true)
    expect(answerKeySchema.safeParse(back.key).success).toBe(true)
    expect(validateQuestion(back.content, back.key)).toEqual([])

    // Re-serialising must be stable, or repeated export/import cycles drift.
    expect(def.serialize(back.content, back.key)).toEqual(row)
  })

  it('serialises to strings only', () => {
    // CSV and Excel cells are strings. A number or object here would stringify
    // unpredictably on export.
    const { content, key } = def.sample()
    for (const [col, value] of Object.entries(def.serialize(content, key))) {
      expect(typeof value, `column ${col}`).toBe('string')
    }
  })

  it('reports a readable error for an empty import row', () => {
    const result = def.deserialize({})
    if ('error' in result) {
      expect(result.error.length).toBeGreaterThan(10)
      expect(result.error).not.toMatch(/undefined|\[object/)
    } else {
      // Formats with no required columns may legitimately accept a blank row;
      // what they must not do is produce something invalid.
      expect(questionContentSchema.safeParse(result.content).success).toBe(true)
    }
  })

  it('grades its own sample as fully correct', () => {
    // End-to-end through the registry: sample → grade. Catches a sample whose
    // key does not actually match its content, which every other test would
    // pass.
    const { content, key } = def.sample()
    if (!def.autoGradable) {
      const r = gradeAnswer(content, key, def.emptyAnswer(), { maxScore: 10 })
      expect(r.status).toBe('not_applicable')
      return
    }

    const correctAnswer = buildCorrectAnswer(format, content, key)
    const result = gradeAnswer(content, key, correctAnswer, { maxScore: 10, negativeMarks: 2 })
    expect(result.score, `${format} sample did not self-grade to full marks`).toBe(10)
  })

  it('grades an empty answer at zero without penalty', () => {
    const { content, key } = def.sample()
    const r = gradeAnswer(content, key, def.emptyAnswer(), { maxScore: 10, negativeMarks: 2 })
    expect(r.score).toBe(0)
  })
})

/** Builds the fully-correct answer for a sample, per format. */
function buildCorrectAnswer(
  format: string,
  content: ReturnType<(typeof FORMAT_REGISTRY)[keyof typeof FORMAT_REGISTRY]['sample']>['content'],
  key: ReturnType<(typeof FORMAT_REGISTRY)[keyof typeof FORMAT_REGISTRY]['sample']>['key'],
) {
  switch (format) {
    case 'choice_single':
      return { format, choice: (key as { correct: string }).correct } as never
    case 'choice_multi':
      return { format, choices: (key as { correct: string[] }).correct } as never
    case 'boolean':
      return { format, value: (key as { correct: boolean }).correct } as never
    case 'blanks': {
      const k = key as { blanks: { id: string; accept: string[] }[] }
      const values: Record<string, string> = {}
      for (const b of k.blanks) values[b.id] = b.accept[0]
      return { format, values } as never
    }
    case 'pairs':
      return { format, mapping: (key as { correct: Record<string, string> }).correct } as never
    case 'order':
      return { format, order: (key as { correct: string[] }).correct } as never
    default:
      return null as never
  }
}

describe('CSV template', () => {
  it('lists the columns each format uses', () => {
    expect(csvColumnsFor('choice_single')).toEqual(['options', 'correct'])
    expect(csvColumnsFor('boolean')).toEqual(['correct'])
  })

  it('produces a template header covering every format', () => {
    const cols = allCsvColumns()
    for (const f of RESPONSE_FORMATS) {
      for (const c of csvColumnsFor(f)) {
        expect(cols, `template header missing "${c}" needed by ${f}`).toContain(c)
      }
    }
  })

  it('does not duplicate shared columns', () => {
    const cols = allCsvColumns()
    expect(cols.length).toBe(new Set(cols).size)
  })
})

describe('CSV import ergonomics', () => {
  it('auto-generates option ids when the author omits them', () => {
    // A chef writing a spreadsheet should be able to type "63°C | 74°C" without
    // inventing ids.
    const r = FORMAT_REGISTRY.choice_single.deserialize({ options: '63°C | 74°C', correct: 'b' })
    expect('error' in r).toBe(false)
    if ('error' in r) return
    const c = r.content as { choices: { id: string; text: string }[] }
    expect(c.choices.map((x) => x.id)).toEqual(['a', 'b'])
    expect(c.choices[1].text).toBe('74°C')
  })

  it('accepts the true/false spellings people actually type', () => {
    for (const raw of ['true', 'TRUE', 'yes', 'y', '1']) {
      const r = FORMAT_REGISTRY.boolean.deserialize({ correct: raw })
      expect('error' in r, raw).toBe(false)
      if (!('error' in r)) expect((r.key as { correct: boolean }).correct).toBe(true)
    }
    for (const raw of ['false', 'no', 'n', '0']) {
      const r = FORMAT_REGISTRY.boolean.deserialize({ correct: raw })
      if (!('error' in r)) expect((r.key as { correct: boolean }).correct).toBe(false)
    }
  })

  it('rejects an unparseable true/false rather than guessing', () => {
    expect('error' in FORMAT_REGISTRY.boolean.deserialize({ correct: 'maybe' })).toBe(true)
  })

  it('derives blank ids from the template', () => {
    // Deriving rather than declaring removes a whole class of "declared a blank
    // that is not in the sentence" authoring errors.
    const r = FORMAT_REGISTRY.blanks.deserialize({
      template: 'Sear at {{temp}}°C for {{mins}} minutes.',
      answers: 'temp::180,175 | mins::3',
    })
    expect('error' in r).toBe(false)
    if ('error' in r) return
    const c = r.content as { blanks: { id: string }[] }
    expect(c.blanks.map((b) => b.id)).toEqual(['temp', 'mins'])
    expect(validateQuestion(r.content, r.key)).toEqual([])
  })

  it('reports which blanks are missing answers', () => {
    const r = FORMAT_REGISTRY.blanks.deserialize({
      template: 'Sear at {{temp}}°C for {{mins}} minutes.',
      answers: 'temp::180',
    })
    expect('error' in r).toBe(true)
    if ('error' in r) expect(r.error).toContain('mins')
  })

  it('defaults a sequence to the order it was written in', () => {
    // The natural way to author a sequence is to type it correctly; the exam
    // shuffles it at delivery.
    const r = FORMAT_REGISTRY.order.deserialize({ items: 'Wash | Sanitise | Portion' })
    expect('error' in r).toBe(false)
    if ('error' in r) return
    expect((r.key as { correct: string[] }).correct).toEqual(['a', 'b', 'c'])
  })

  it('infers distractors when the right column is longer', () => {
    const r = FORMAT_REGISTRY.pairs.deserialize({
      left: 'l1::Dashi | l2::Soffritto',
      right: 'r1::Japanese | r2::Italian | r3::Thai',
      correct: 'l1::r1 | l2::r2',
    })
    expect('error' in r).toBe(false)
    if ('error' in r) return
    expect((r.content as { hasDistractors: boolean }).hasDistractors).toBe(true)
    expect(validateQuestion(r.content, r.key)).toEqual([])
  })
})
