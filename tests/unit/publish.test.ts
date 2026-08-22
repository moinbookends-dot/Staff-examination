import { describe, it, expect } from 'vitest'
import { publishIssues, canPublish } from '@/lib/questions/publish'
import { FORMAT_REGISTRY } from '@/lib/questions/registry'
import { RESPONSE_FORMATS } from '@/lib/questions/schemas'

/**
 * The publish gate.
 *
 * This is the check that stands between a half-written question and an exam
 * paper. Every case below is a question that would otherwise reach a candidate:
 * blank options, a key naming an option that does not exist, a rubric with no
 * criteria. None of them throw at runtime — they simply mark people wrong, or
 * present an unanswerable question, silently.
 */

describe.each(RESPONSE_FORMATS)('publish gate: %s', (format) => {
  const definition = FORMAT_REGISTRY[format]

  it('passes the format sample', () => {
    const { content, key } = definition.sample()
    expect(publishIssues(content, key), `${format} sample should be publishable`).toEqual([])
    expect(canPublish(content, key)).toBe(true)
  })

  it('refuses a brand-new empty question', () => {
    // The mirror of the registry conformance test: emptyContent() must parse as
    // a DRAFT and must NOT be publishable. Formats with no author-supplied
    // collections are structurally complete on their own, so they are excluded
    // there — but the ones that carry a key still fail here, and evaluator_only
    // fails on its empty rubric label.
    const issues = publishIssues(definition.emptyContent(), definition.emptyKey())

    if (['boolean', 'text_short', 'text_long'].includes(format)) {
      // No collections and no required key contents: the stem alone makes these
      // real questions, so an empty payload is legitimately publishable.
      expect(issues).toEqual([])
      return
    }
    expect(issues.length, `${format} empty question was publishable`).toBeGreaterThan(0)
  })

  it('reports issues with a path and a message', () => {
    for (const issue of publishIssues(definition.emptyContent(), definition.emptyKey())) {
      expect(issue.path.length).toBeGreaterThan(0)
      expect(issue.message.length).toBeGreaterThan(5)
      expect(issue.message).not.toMatch(/undefined|\[object/)
    }
  })
})

describe('publish gate — the failures that matter', () => {
  it('catches a key naming an option that does not exist', () => {
    // The reason validateQuestion exists. Both halves parse perfectly; the
    // question then marks every candidate wrong with no error anywhere.
    const issues = publishIssues(
      { format: 'choice_single', choices: [{ id: 'a', text: '63°C' }, { id: 'b', text: '74°C' }] },
      { format: 'choice_single', correct: 'c' },
    )
    expect(issues.some((i) => i.message.includes('not one of the options'))).toBe(true)
  })

  it('catches an option left blank', () => {
    const issues = publishIssues(
      { format: 'choice_single', choices: [{ id: 'a', text: '63°C' }, { id: 'b', text: '' }] },
      { format: 'choice_single', correct: 'a' },
    )
    expect(issues.length).toBeGreaterThan(0)
    // Prefixed, so the chef knows it is an option rather than the answer key.
    expect(issues[0].path.startsWith('content.')).toBe(true)
  })

  it('catches every option being marked correct', () => {
    const issues = publishIssues(
      {
        format: 'choice_multi',
        choices: [{ id: 'a', text: 'Wash' }, { id: 'b', text: 'Sanitise' }],
      },
      { format: 'choice_multi', correct: ['a', 'b'], partialCredit: true },
    )
    expect(issues.some((i) => i.message.includes('cannot discriminate'))).toBe(true)
  })

  it('catches a blank that is not in the sentence', () => {
    const issues = publishIssues(
      { format: 'blanks', template: 'Sear at {{temp}}°C.', blanks: [{ id: 'temp' }, { id: 'mins' }] },
      {
        format: 'blanks',
        partialCredit: true,
        blanks: [
          { id: 'temp', accept: ['180'], match: 'ci' },
          { id: 'mins', accept: ['3'], match: 'ci' },
        ],
      },
    )
    expect(issues.some((i) => i.message.includes('does not appear in the text'))).toBe(true)
  })

  it('catches mismatched match columns without distractors', () => {
    const issues = publishIssues(
      {
        format: 'pairs',
        left: [{ id: 'l1', text: 'Dashi' }, { id: 'l2', text: 'Soffritto' }],
        right: [
          { id: 'r1', text: 'Japanese' },
          { id: 'r2', text: 'Italian' },
          { id: 'r3', text: 'Thai' },
        ],
        hasDistractors: false,
      },
      { format: 'pairs', correct: { l1: 'r1', l2: 'r2' }, partialCredit: true },
    )
    expect(issues.some((i) => i.message.includes('Column sizes differ'))).toBe(true)
  })

  it('refuses when content and key are different formats', () => {
    // Cannot happen through the editor, which holds the pair together — but it
    // can through an import or a hand-built payload, and the result would be an
    // ungradeable question.
    const issues = publishIssues(
      { format: 'boolean' },
      { format: 'choice_single', correct: 'a' },
    )
    expect(issues.length).toBeGreaterThan(0)
  })

  it('does not run cross-shape checks on an unparseable payload', () => {
    // Reporting "correct answer is not one of the options" when the real problem
    // is that there are no options is technically true and useless.
    const issues = publishIssues({ format: 'choice_single' }, { format: 'choice_single', correct: 'a' })
    expect(issues.every((i) => i.path.startsWith('content.') || i.path.startsWith('answerKey.'))).toBe(
      true,
    )
  })

  it('refuses complete rubbish without throwing', () => {
    expect(() => publishIssues(null, undefined)).not.toThrow()
    expect(canPublish(null, undefined)).toBe(false)
    expect(canPublish('not a question', 42)).toBe(false)
  })
})
