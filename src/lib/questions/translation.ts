import { z } from 'zod'
import type { QuestionContent, QuestionContentDraft, ValidationIssue } from './schemas'
import type { RenderableContent } from '@/components/questions/types'

/**
 * Question translations — the shape, and the merge.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THERE IS NO ANSWER KEY ON THIS SURFACE, BY CONSTRUCTION.                  │
 * │                                                                           │
 * │ A translation is display strings keyed by the base row's ids and nothing  │
 * │ else — 0009 said so, and 0032 made it a CHECK constraint. Every type      │
 * │ below is `Record<string, string>` or a bare string for that reason: there │
 * │ is nowhere in this file to put "and this one is correct", so a translator │
 * │ cannot change what a question is worth even by accident.                  │
 * │                                                                           │
 * │ Per-locale accepted answers for fill-in-the-blank live in the ANSWER KEY, │
 * │ which questions.translate cannot write.                                   │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Pure — no `server-only` — because the same functions are needed in three
 * places: the workbench preview, the unit tests, and (in 0033) the delivery
 * path that renders a candidate's paper in their language.
 */

/**
 * Display strings keyed by the base row's ids.
 *
 * Not a discriminated union: the format is carried by the question, not by the
 * translation, and the stored jsonb has no `format` key. Which fields are legal
 * is decided by the base row's format, and enforced by 0032's CHECK.
 */
export interface TranslationContent {
  /** choice_single, choice_multi — id → option text. */
  choices?: Record<string, string>
  /** pairs — id → left/right text. */
  left?: Record<string, string>
  right?: Record<string, string>
  /** order — id → item text. */
  items?: Record<string, string>
  /** blanks — the prose, carrying the SAME {{id}} placeholders as the base. */
  template?: string
  /** blanks — id → the hint beside an input. */
  blankLabels?: Record<string, string>
  /** evaluator_only — what the assessor is told to do. */
  instructions?: string
}

const strings = z.record(z.string().min(1).max(64), z.string().max(2000))

/**
 * STRICT, deliberately. Zod strips unknown keys by default, which would quietly
 * accept `{correct: "a"}` and drop it — leaving the caller believing they saved
 * something they did not, and mirroring 0032's CHECK only by accident. The
 * database rejects an illegal key outright; so does this.
 */
export const translationContentSchema: z.ZodType<TranslationContent> = z
  .object({
    choices: strings.optional(),
    left: strings.optional(),
    right: strings.optional(),
    items: strings.optional(),
    template: z.string().max(4000).optional(),
    blankLabels: strings.optional(),
    instructions: z.string().max(4000).optional(),
  })
  .strict()

export const LOCALES = ['en', 'hi', 'gu', 'hi-Latn'] as const
export type Locale = (typeof LOCALES)[number]
export type TranslationStatus = 'draft' | 'review' | 'published'

/** The ids a format exposes for translation, read off the base content. */
function idsOf(base: RenderableContent, key: keyof TranslationContent): string[] {
  const c = base as Record<string, unknown>
  const source =
    key === 'blankLabels' ? c.blanks : key === 'choices' ? c.choices : c[key as string]
  if (!Array.isArray(source)) return []
  return source.map((item) => String((item as { id?: unknown }).id ?? '')).filter(Boolean)
}

/** An empty translation shaped for the base question — nothing pre-filled. */
export function emptyTranslation(base: QuestionContentDraft | QuestionContent): TranslationContent {
  switch (base.format) {
    case 'choice_single':
    case 'choice_multi':
      return { choices: {} }
    case 'pairs':
      return { left: {}, right: {} }
    case 'order':
      return { items: {} }
    case 'blanks':
      return { template: '', blankLabels: {} }
    case 'evaluator_only':
      return { instructions: '' }
    default:
      // boolean, text_short, text_long — the stem is the whole translation.
      return {}
  }
}

/** `{{id}}` placeholders, deduplicated and ordered, so two templates compare. */
export function placeholdersIn(template: string): string[] {
  return [...new Set([...template.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]))].sort()
}

/**
 * Problems a translator should fix, mirroring 0032's server-side checks.
 *
 * The database refuses these too — this exists so the workbench can say what is
 * wrong before a round trip, not so the rule lives in two places. The database
 * is the authority; this is the courtesy.
 */
export function translationIssues(
  base: RenderableContent,
  value: TranslationContent,
): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  for (const key of ['choices', 'left', 'right', 'items', 'blankLabels'] as const) {
    const map = value[key]
    if (!map) continue
    const known = new Set(idsOf(base, key))
    for (const id of Object.keys(map)) {
      if (!known.has(id)) {
        issues.push({ path: `${key}.${id}`, message: `"${id}" is not part of this question.` })
      }
    }
  }

  // The one that silently costs marks: fewer inputs than there are graded
  // blanks. See 0032's header.
  if (base.format === 'blanks' && value.template) {
    const want = placeholdersIn(String((base as { template?: unknown }).template ?? ''))
    const got = placeholdersIn(value.template)
    if (want.join(',') !== got.join(',')) {
      issues.push({
        path: 'template',
        message: `The blanks must match the question exactly — it has ${
          want.join(', ') || 'none'
        }, this has ${got.join(', ') || 'none'}.`,
      })
    }
  }

  return issues
}

/**
 * Base structure, translated strings.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THIS CANNOT BE DONE IN SQL WITH `||`, AND THAT IS WHY IT LIVES HERE.      │
 * │                                                                           │
 * │ The base carries `choices` as an ARRAY of {id, text}; a translation       │
 * │ carries it as an OBJECT of id → text. jsonb's `||` is a shallow merge, so │
 * │ `base || translation` replaces the array with the object and every        │
 * │ renderer breaks on `.map`. A correct SQL merge means reimplementing nine  │
 * │ shapes in PL/pgSQL beside this one — and two implementations of "which    │
 * │ text goes with which id" drift into a candidate reading an option whose   │
 * │ text no longer matches its id.                                            │
 * │                                                                           │
 * │ So 0033's delivery path selects the locale in SQL and calls THIS to merge.│
 * │ One implementation, shared by the authoring preview and the real paper.   │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Anything the translation omits keeps its base text, so a half-finished
 * translation renders as a readable mixture rather than as gaps.
 */
export function mergeTranslation(
  base: RenderableContent,
  value: TranslationContent | null | undefined,
): RenderableContent {
  if (!value) return base

  const translate = (list: unknown, map: Record<string, string> | undefined) => {
    if (!Array.isArray(list)) return list
    if (!map) return list
    return list.map((item) => {
      const id = String((item as { id?: unknown }).id ?? '')
      const text = map[id]
      return text ? { ...(item as object), text } : item
    })
  }

  switch (base.format) {
    case 'choice_single':
    case 'choice_multi':
      return { ...base, choices: translate((base as { choices: unknown }).choices, value.choices) } as RenderableContent

    case 'pairs':
      return {
        ...base,
        left: translate((base as { left: unknown }).left, value.left),
        right: translate((base as { right: unknown }).right, value.right),
      } as RenderableContent

    case 'order':
      return { ...base, items: translate((base as { items: unknown }).items, value.items) } as RenderableContent

    case 'blanks': {
      const blanks = Array.isArray((base as { blanks?: unknown }).blanks)
        ? ((base as { blanks: Array<{ id: string; label?: string }> }).blanks).map((b) => {
            const label = value.blankLabels?.[b.id]
            return label ? { ...b, label } : b
          })
        : (base as { blanks?: unknown }).blanks
      return {
        ...base,
        ...(value.template ? { template: value.template } : {}),
        blanks,
      } as RenderableContent
    }

    case 'evaluator_only':
      return {
        ...base,
        ...(value.instructions ? { instructions: value.instructions } : {}),
      } as RenderableContent

    default:
      // boolean, text_short, text_long carry no translatable content.
      return base
  }
}
