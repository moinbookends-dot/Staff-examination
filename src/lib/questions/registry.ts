import type { ZodType } from 'zod'
import {
  questionContentSchema,
  answerKeySchema,
  answerPayloadSchema,
  validateQuestion,
  isAutoGradable,
  RESPONSE_FORMATS,
  type ResponseFormat,
  type QuestionContent,
  type AnswerKey,
  type AnswerPayload,
  type ValidationIssue,
} from './schemas'

/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║  THE HEADLESS FORMAT REGISTRY.                                            ║
 * ║                                                                           ║
 * ║  Everything about a question format that is NOT a React component.        ║
 * ║  Pure TypeScript — no React, no DOM, no Next.js.                          ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * WHY THIS IS SPLIT FROM THE UI REGISTRY (src/components/questions/registry.tsx):
 *
 * Four consumers need format behaviour without ever rendering anything:
 *   · CSV / Excel bulk import (M2) and cookbook imports
 *   · Server-side grading at submission (M4)
 *   · AI question generation (Phase 3) — validates before queueing
 *   · Seed and migration scripts, which run in plain Node
 *
 * A single registry importing editor components would pull React into all of
 * them, break the Node scripts outright, and bloat the server bundle. The UI
 * registry imports THIS one, never the reverse.
 *
 * ADDING A FORMAT: one entry here, one editor, one renderer. The exhaustiveness
 * test in tests/unit/registry.test.ts fails if any of the three is missing.
 */

export interface FormatDefinition<
  C extends QuestionContent = QuestionContent,
  K extends AnswerKey = AnswerKey,
  A extends AnswerPayload = AnswerPayload,
> {
  format: ResponseFormat

  /** i18n key under the `questions.formats` namespace. Never a literal string —
   *  format names appear in the authoring UI, which is fully translated. */
  labelKey: string
  descriptionKey: string

  /** Can the machine score it, or does it need a human? Drives an exam's
   *  requires_manual_grading flag and the evaluation queue. */
  autoGradable: boolean

  /** Does a candidate produce free text? Determines whether the renderer needs
   *  an IME-friendly input for Devanagari and Gujarati. */
  freeText: boolean

  /** Media that makes sense as a stimulus. All formats accept all kinds — this
   *  drives which upload affordances the editor offers first. */
  supportsMedia: boolean

  /** A blank content payload, for "new question". */
  emptyContent: () => C
  emptyKey: () => K
  /** The "nothing entered yet" answer, so renderers never deal with undefined. */
  emptyAnswer: () => A

  /** Round-trip for CSV/Excel import and export. */
  serialize: (content: C, key: K) => Record<string, string>
  deserialize: (row: Record<string, string>) => { content: C; key: K } | { error: string }

  /** A worked example, used by import templates and AI few-shot prompts. */
  sample: () => { content: C; key: K }
}

// ─────────────────────────────────────────────────────────────────────────────
// CSV helpers
//
// The import format is deliberately human-writable: a chef fills a spreadsheet,
// not JSON. Pipe-separated because commas appear constantly in food text
// ("salt, pepper and thyme") and would need quoting everywhere.
// ─────────────────────────────────────────────────────────────────────────────

const SEP = '|'

/** "a::63°C | b::74°C" → choices, preserving author-supplied ids. */
function parseChoices(raw: string): { id: string; text: string }[] {
  return raw
    .split(SEP)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part, i) => {
      const idx = part.indexOf('::')
      if (idx === -1) {
        // No explicit id: generate a, b, c… so the common case stays terse.
        return { id: String.fromCharCode(97 + i), text: part }
      }
      return { id: part.slice(0, idx).trim(), text: part.slice(idx + 2).trim() }
    })
}

function formatChoices(choices: { id: string; text: string }[]): string {
  return choices.map((c) => `${c.id}::${c.text}`).join(` ${SEP} `)
}

function splitList(raw: string): string[] {
  return raw.split(SEP).map((s) => s.trim()).filter(Boolean)
}

// ─────────────────────────────────────────────────────────────────────────────
// Definitions
// ─────────────────────────────────────────────────────────────────────────────

const choiceSingle: FormatDefinition = {
  format: 'choice_single',
  labelKey: 'choice_single.label',
  descriptionKey: 'choice_single.description',
  autoGradable: true,
  freeText: false,
  supportsMedia: true,
  emptyContent: () => ({
    format: 'choice_single',
    choices: [
      { id: 'a', text: '' },
      { id: 'b', text: '' },
    ],
  }),
  emptyKey: () => ({ format: 'choice_single', correct: 'a' }),
  emptyAnswer: () => ({ format: 'choice_single', choice: null }),

  serialize: (content, key) => {
    const c = content as Extract<QuestionContent, { format: 'choice_single' }>
    const k = key as Extract<AnswerKey, { format: 'choice_single' }>
    return { options: formatChoices(c.choices), correct: k.correct }
  },
  deserialize: (row) => {
    const choices = parseChoices(row.options ?? '')
    if (choices.length < 2) return { error: 'Give at least two options, separated by |' }
    const correct = (row.correct ?? '').trim()
    if (!correct) return { error: 'Set the correct option id' }
    return {
      content: { format: 'choice_single', choices },
      key: { format: 'choice_single', correct },
    }
  },
  sample: () => ({
    content: {
      format: 'choice_single',
      choices: [
        { id: 'a', text: '63°C' },
        { id: 'b', text: '74°C' },
        { id: 'c', text: '82°C' },
      ],
    },
    key: { format: 'choice_single', correct: 'b' },
  }),
}

const choiceMulti: FormatDefinition = {
  format: 'choice_multi',
  labelKey: 'choice_multi.label',
  descriptionKey: 'choice_multi.description',
  autoGradable: true,
  freeText: false,
  supportsMedia: true,
  emptyContent: () => ({
    format: 'choice_multi',
    choices: [
      { id: 'a', text: '' },
      { id: 'b', text: '' },
    ],
  }),
  emptyKey: () => ({ format: 'choice_multi', correct: [], partialCredit: true }),
  emptyAnswer: () => ({ format: 'choice_multi', choices: [] }),

  serialize: (content, key) => {
    const c = content as Extract<QuestionContent, { format: 'choice_multi' }>
    const k = key as Extract<AnswerKey, { format: 'choice_multi' }>
    return {
      options: formatChoices(c.choices),
      correct: k.correct.join(` ${SEP} `),
      partial_credit: k.partialCredit ? 'yes' : 'no',
    }
  },
  deserialize: (row) => {
    const choices = parseChoices(row.options ?? '')
    if (choices.length < 2) return { error: 'Give at least two options, separated by |' }
    const correct = splitList(row.correct ?? '')
    if (correct.length === 0) return { error: 'Mark at least one option correct' }
    return {
      content: { format: 'choice_multi', choices },
      key: {
        format: 'choice_multi',
        correct,
        partialCredit: (row.partial_credit ?? 'yes').toLowerCase() !== 'no',
      },
    }
  },
  sample: () => ({
    content: {
      format: 'choice_multi',
      choices: [
        { id: 'a', text: 'Wash hands' },
        { id: 'b', text: 'Change gloves' },
        { id: 'c', text: 'Reuse the same board' },
        { id: 'd', text: 'Sanitise the surface' },
      ],
    },
    key: { format: 'choice_multi', correct: ['a', 'b', 'd'], partialCredit: true },
  }),
}

const booleanFormat: FormatDefinition = {
  format: 'boolean',
  labelKey: 'boolean.label',
  descriptionKey: 'boolean.description',
  autoGradable: true,
  freeText: false,
  supportsMedia: true,
  emptyContent: () => ({ format: 'boolean' }),
  emptyKey: () => ({ format: 'boolean', correct: true }),
  emptyAnswer: () => ({ format: 'boolean', value: null }),

  serialize: (_content, key) => {
    const k = key as Extract<AnswerKey, { format: 'boolean' }>
    return { correct: k.correct ? 'true' : 'false' }
  },
  deserialize: (row) => {
    const raw = (row.correct ?? '').trim().toLowerCase()
    // Accept the spellings a chef actually types in a spreadsheet.
    if (['true', 't', 'yes', 'y', '1'].includes(raw)) {
      return { content: { format: 'boolean' }, key: { format: 'boolean', correct: true } }
    }
    if (['false', 'f', 'no', 'n', '0'].includes(raw)) {
      return { content: { format: 'boolean' }, key: { format: 'boolean', correct: false } }
    }
    return { error: 'Set correct to true or false' }
  },
  sample: () => ({
    content: { format: 'boolean' },
    key: { format: 'boolean', correct: true },
  }),
}

const blanks: FormatDefinition = {
  format: 'blanks',
  labelKey: 'blanks.label',
  descriptionKey: 'blanks.description',
  autoGradable: true,
  freeText: true,
  supportsMedia: true,
  emptyContent: () => ({ format: 'blanks', template: '', blanks: [] }),
  emptyKey: () => ({ format: 'blanks', blanks: [], partialCredit: true }),
  emptyAnswer: () => ({ format: 'blanks', values: {} }),

  serialize: (content, key) => {
    const c = content as Extract<QuestionContent, { format: 'blanks' }>
    const k = key as Extract<AnswerKey, { format: 'blanks' }>
    return {
      template: c.template,
      answers: k.blanks.map((b) => `${b.id}::${b.accept.join(',')}`).join(` ${SEP} `),
      match_mode: k.blanks[0]?.match ?? 'ci',
      partial_credit: k.partialCredit ? 'yes' : 'no',
    }
  },
  deserialize: (row) => {
    const template = (row.template ?? '').trim()
    if (!template) return { error: 'Give the sentence, using {{id}} for each blank' }

    // Ids come from the template itself: the chef writes the sentence and the
    // blanks are wherever they put the placeholders. Deriving them avoids a
    // whole class of "declared a blank that is not in the text" mistakes.
    const ids = [...template.matchAll(/\{\{([a-zA-Z0-9_-]+)\}\}/g)].map((m) => m[1])
    if (ids.length === 0) return { error: 'The sentence has no {{blank}} placeholders' }

    const answerMap = new Map<string, string[]>()
    for (const part of splitList(row.answers ?? '')) {
      const idx = part.indexOf('::')
      if (idx === -1) continue
      answerMap.set(
        part.slice(0, idx).trim(),
        part.slice(idx + 2).split(',').map((s) => s.trim()).filter(Boolean),
      )
    }

    const missing = ids.filter((id) => !answerMap.has(id))
    if (missing.length) return { error: `No accepted answers for: ${missing.join(', ')}` }

    const mode = (row.match_mode ?? 'ci').trim().toLowerCase()
    const match = (['exact', 'ci', 'fuzzy', 'regex'].includes(mode) ? mode : 'ci') as
      'exact' | 'ci' | 'fuzzy' | 'regex'

    return {
      content: { format: 'blanks', template, blanks: ids.map((id) => ({ id })) },
      key: {
        format: 'blanks',
        partialCredit: (row.partial_credit ?? 'yes').toLowerCase() !== 'no',
        blanks: ids.map((id) => ({
          id,
          accept: answerMap.get(id)!,
          match,
          ...(match === 'fuzzy' ? { tolerance: 1 } : {}),
        })),
      },
    }
  },
  sample: () => ({
    content: {
      format: 'blanks',
      template: 'Cook chicken to an internal temperature of {{temp}}°C.',
      blanks: [{ id: 'temp' }],
    },
    key: {
      format: 'blanks',
      partialCredit: true,
      blanks: [{ id: 'temp', accept: ['74', '75'], match: 'ci' }],
    },
  }),
}

const pairs: FormatDefinition = {
  format: 'pairs',
  labelKey: 'pairs.label',
  descriptionKey: 'pairs.description',
  autoGradable: true,
  freeText: false,
  supportsMedia: true,
  emptyContent: () => ({ format: 'pairs', left: [], right: [], hasDistractors: false }),
  emptyKey: () => ({ format: 'pairs', correct: {}, partialCredit: true }),
  emptyAnswer: () => ({ format: 'pairs', mapping: {} }),

  serialize: (content, key) => {
    const c = content as Extract<QuestionContent, { format: 'pairs' }>
    const k = key as Extract<AnswerKey, { format: 'pairs' }>
    return {
      left: formatChoices(c.left),
      right: formatChoices(c.right),
      correct: Object.entries(k.correct).map(([l, r]) => `${l}::${r}`).join(` ${SEP} `),
      partial_credit: k.partialCredit ? 'yes' : 'no',
    }
  },
  deserialize: (row) => {
    const left = parseChoices(row.left ?? '')
    const right = parseChoices(row.right ?? '')
    if (left.length < 2 || right.length < 2) return { error: 'Give at least two items on each side' }

    const correct: Record<string, string> = {}
    for (const part of splitList(row.correct ?? '')) {
      const idx = part.indexOf('::')
      if (idx === -1) continue
      correct[part.slice(0, idx).trim()] = part.slice(idx + 2).trim()
    }
    if (Object.keys(correct).length === 0) return { error: 'Give the correct pairings as left::right' }

    return {
      content: { format: 'pairs', left, right, hasDistractors: right.length > left.length },
      key: {
        format: 'pairs',
        correct,
        partialCredit: (row.partial_credit ?? 'yes').toLowerCase() !== 'no',
      },
    }
  },
  sample: () => ({
    content: {
      format: 'pairs',
      left: [{ id: 'l1', text: 'Dashi' }, { id: 'l2', text: 'Soffritto' }],
      right: [{ id: 'r1', text: 'Japanese' }, { id: 'r2', text: 'Italian' }],
      hasDistractors: false,
    },
    key: { format: 'pairs', correct: { l1: 'r1', l2: 'r2' }, partialCredit: true },
  }),
}

const order: FormatDefinition = {
  format: 'order',
  labelKey: 'order.label',
  descriptionKey: 'order.description',
  autoGradable: true,
  freeText: false,
  supportsMedia: true,
  emptyContent: () => ({ format: 'order', items: [] }),
  emptyKey: () => ({ format: 'order', correct: [], scoring: 'exact' }),
  emptyAnswer: () => ({ format: 'order', order: [] }),

  serialize: (content, key) => {
    const c = content as Extract<QuestionContent, { format: 'order' }>
    const k = key as Extract<AnswerKey, { format: 'order' }>
    return {
      items: formatChoices(c.items),
      correct: k.correct.join(` ${SEP} `),
      scoring: k.scoring,
    }
  },
  deserialize: (row) => {
    const items = parseChoices(row.items ?? '')
    if (items.length < 2) return { error: 'Give at least two items to order' }

    // Default the correct order to the order they were written in — the natural
    // way to author a sequence is to type it correctly, then let the exam
    // shuffle it.
    const correct = splitList(row.correct ?? '')
    const finalOrder = correct.length ? correct : items.map((i) => i.id)

    const s = (row.scoring ?? 'exact').trim().toLowerCase()
    const scoring = (['exact', 'adjacent', 'kendall'].includes(s) ? s : 'exact') as
      'exact' | 'adjacent' | 'kendall'

    return {
      content: { format: 'order', items },
      key: { format: 'order', correct: finalOrder, scoring },
    }
  },
  sample: () => ({
    content: {
      format: 'order',
      items: [
        { id: 's1', text: 'Wash hands' },
        { id: 's2', text: 'Sanitise the board' },
        { id: 's3', text: 'Portion the fish' },
      ],
    },
    key: { format: 'order', correct: ['s1', 's2', 's3'], scoring: 'adjacent' },
  }),
}

const textShort: FormatDefinition = {
  format: 'text_short',
  labelKey: 'text_short.label',
  descriptionKey: 'text_short.description',
  autoGradable: false,
  freeText: true,
  supportsMedia: true,
  emptyContent: () => ({ format: 'text_short', maxChars: 300 }),
  emptyKey: () => ({ format: 'text_short', keywords: [] }),
  emptyAnswer: () => ({ format: 'text_short', text: '' }),

  serialize: (content, key) => {
    const c = content as Extract<QuestionContent, { format: 'text_short' }>
    const k = key as Extract<AnswerKey, { format: 'text_short' }>
    return {
      max_chars: String(c.maxChars),
      model_answer: k.modelAnswer ?? '',
      keywords: k.keywords.join(` ${SEP} `),
    }
  },
  deserialize: (row) => ({
    content: { format: 'text_short', maxChars: Number(row.max_chars) || 300 },
    key: {
      format: 'text_short',
      modelAnswer: row.model_answer?.trim() || undefined,
      keywords: splitList(row.keywords ?? ''),
    },
  }),
  sample: () => ({
    content: { format: 'text_short', maxChars: 300 },
    key: {
      format: 'text_short',
      modelAnswer: 'Separate boards and utensils; wash hands between tasks.',
      keywords: ['separate', 'wash hands', 'sanitise'],
    },
  }),
}

const textLong: FormatDefinition = {
  format: 'text_long',
  labelKey: 'text_long.label',
  descriptionKey: 'text_long.description',
  autoGradable: false,
  freeText: true,
  supportsMedia: true,
  emptyContent: () => ({ format: 'text_long', maxWords: 500 }),
  emptyKey: () => ({ format: 'text_long', rubric: [] }),
  emptyAnswer: () => ({ format: 'text_long', text: '' }),

  serialize: (content, key) => {
    const c = content as Extract<QuestionContent, { format: 'text_long' }>
    const k = key as Extract<AnswerKey, { format: 'text_long' }>
    return {
      max_words: String(c.maxWords),
      model_answer: k.modelAnswer ?? '',
      rubric: k.rubric.map((r) => `${r.id}::${r.label}::${r.max}`).join(` ${SEP} `),
    }
  },
  deserialize: (row) => {
    const rubric = splitList(row.rubric ?? '').flatMap((part) => {
      const [id, label, max] = part.split('::').map((s) => s.trim())
      if (!id || !label) return []
      return [{ id, label, max: Number(max) || 1 }]
    })
    return {
      content: { format: 'text_long', maxWords: Number(row.max_words) || 500 },
      key: { format: 'text_long', modelAnswer: row.model_answer?.trim() || undefined, rubric },
    }
  },
  sample: () => ({
    content: { format: 'text_long', maxWords: 400 },
    key: {
      format: 'text_long',
      rubric: [
        { id: 'c1', label: 'Identifies the hazard', max: 3 },
        { id: 'c2', label: 'Describes the control', max: 4 },
        { id: 'c3', label: 'Explains verification', max: 3 },
      ],
    },
  }),
}

const evaluatorOnly: FormatDefinition = {
  format: 'evaluator_only',
  labelKey: 'evaluator_only.label',
  descriptionKey: 'evaluator_only.description',
  autoGradable: false,
  freeText: false,
  supportsMedia: true,
  emptyContent: () => ({ format: 'evaluator_only' }),
  emptyKey: () => ({ format: 'evaluator_only', rubric: [{ id: 'c1', label: '', max: 5 }] }),
  emptyAnswer: () => ({ format: 'evaluator_only', attachments: [] }),

  serialize: (content, key) => {
    const c = content as Extract<QuestionContent, { format: 'evaluator_only' }>
    const k = key as Extract<AnswerKey, { format: 'evaluator_only' }>
    return {
      instructions: c.instructions ?? '',
      rubric: k.rubric.map((r) => `${r.id}::${r.label}::${r.max}`).join(` ${SEP} `),
    }
  },
  deserialize: (row) => {
    const rubric = splitList(row.rubric ?? '').flatMap((part) => {
      const [id, label, max] = part.split('::').map((s) => s.trim())
      if (!id || !label) return []
      return [{ id, label, max: Number(max) || 1 }]
    })
    if (rubric.length === 0) return { error: 'Give at least one rubric criterion as id::label::marks' }
    return {
      content: { format: 'evaluator_only', instructions: row.instructions?.trim() || undefined },
      key: { format: 'evaluator_only', rubric },
    }
  },
  sample: () => ({
    content: { format: 'evaluator_only', instructions: 'Observe the candidate breaking down a whole fish.' },
    key: {
      format: 'evaluator_only',
      rubric: [
        { id: 'c1', label: 'Knife control and safety', max: 5 },
        { id: 'c2', label: 'Yield and waste', max: 5 },
      ],
    },
  }),
}

// ─────────────────────────────────────────────────────────────────────────────

export const FORMAT_REGISTRY: Record<ResponseFormat, FormatDefinition> = {
  choice_single: choiceSingle,
  choice_multi: choiceMulti,
  boolean: booleanFormat,
  blanks,
  pairs,
  order,
  text_short: textShort,
  text_long: textLong,
  evaluator_only: evaluatorOnly,
}

export function getFormat(format: ResponseFormat): FormatDefinition {
  const def = FORMAT_REGISTRY[format]
  if (!def) throw new Error(`No registry entry for response format "${format}"`)
  return def
}

export const ALL_FORMATS: FormatDefinition[] = RESPONSE_FORMATS.map((f) => FORMAT_REGISTRY[f])

/** CSV column names a format uses, beyond the shared metadata columns. */
export function csvColumnsFor(format: ResponseFormat): string[] {
  const { content, key } = getFormat(format).sample()
  return Object.keys(getFormat(format).serialize(content, key))
}

/** Every format-specific CSV column across all formats — the import template header. */
export function allCsvColumns(): string[] {
  const seen = new Set<string>()
  for (const f of RESPONSE_FORMATS) for (const col of csvColumnsFor(f)) seen.add(col)
  return [...seen]
}

// Re-exported so consumers need one import, not four.
export {
  questionContentSchema,
  answerKeySchema,
  answerPayloadSchema,
  validateQuestion,
  isAutoGradable,
}
export type {
  ResponseFormat,
  QuestionContent,
  AnswerKey,
  AnswerPayload,
  ValidationIssue,
  ZodType,
}
