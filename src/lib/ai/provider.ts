import type { SourceDocumentKind } from '../imports/source-documents'
import type { BloomLevel } from '../questions/metadata'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * What an AI provider is, said without naming one.
 *
 * Every payload below is spelled in this product's nouns — pages, knowledge
 * units, questions, Bloom levels, source document kinds. Nothing here is a
 * vendor's noun. There is no system prompt, no message list, no temperature,
 * no token budget, no tool schema, and no model catalogue, because the moment
 * one of those appears in this file the abstraction has stopped being an
 * abstraction: every caller would then be writing to one vendor's request
 * shape with a thin coat of paint over it, and swapping vendors would mean
 * editing the call sites rather than adding an adapter.
 *
 * The direction of truth runs one way. An adapter translates a vendor's reply
 * into these shapes; nothing in src/ outside an adapter file ever sees the
 * other side of that translation.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE TWO TYPE IMPORTS ARE THE POINT, NOT A LEAK.                           │
 * │                                                                           │
 * │ `import type` is erased at compile time, so this file still pulls in no   │
 * │ runtime code — but a generated question carries a Bloom level and an      │
 * │ extraction is told what kind of document it is reading, and both of those │
 * │ vocabularies already exist. Re-spelling either as a bare `string` here is │
 * │ the exact failure metadata.ts was written to end: a second hand-written   │
 * │ copy that drifts, and a provider free to return `analyse` where the       │
 * │ Postgres enum says `analyze`.                                             │
 * │                                                                           │
 * │ Mapping a vendor's own taxonomy onto ours is the adapter's job, and it is │
 * │ a compile error there rather than a 23514 at insert time here.            │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * What a provider can be asked to do, in pipeline order.
 *
 * Order is meaningful: 0048's three tables run OCR → extraction → generation,
 * and a provider that can generate but cannot OCR is useful only downstream of
 * one that can. Anything rendering a capability list reads it in this order.
 */
export const AI_CAPABILITIES = ['ocr', 'extract', 'generate'] as const

export type AiCapability = (typeof AI_CAPABILITIES)[number]

/**
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THESE ARE NOT import_batches.kind, AND THE DIFFERENCE IS DELIBERATE.      │
 * │                                                                           │
 * │ 0048 spells the batch kinds `'ocr','extraction','generation'` — nouns for │
 * │ a run that happened. A capability is a verb for something a provider can  │
 * │ be asked to do, and two of the three words differ. That is a real trap:   │
 * │ a call site writing `kind: capability` compiles, inserts `extract`, and   │
 * │ comes back as a bare 23514 with the bytes already uploaded.               │
 * │                                                                           │
 * │ So the translation lives here once, as a total Record — adding a fourth   │
 * │ capability without deciding which batch kind records it is a build error, │
 * │ not a runtime surprise.                                                   │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export const BATCH_KIND_FOR_CAPABILITY: Record<
  AiCapability,
  'ocr' | 'extraction' | 'generation'
> = {
  ocr: 'ocr',
  extract: 'extraction',
  generate: 'generation',
}

/**
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ ONE LITERAL, BECAUSE THE PURGE IS A `like` AND NOT A TYPE.                │
 * │                                                                           │
 * │ `synthetic: true` on the drafts below is what the TypeScript layer reads. │
 * │ It does not survive the insert: a knowledge unit that reached the bank    │
 * │ from a mock run is an ordinary row, and the person who has to find every  │
 * │ one of them six weeks later is holding psql, not a type checker.          │
 * │                                                                           │
 * │ So every text field the mock emits is prefixed with this marker, and the  │
 * │ purge is one predicate over one string. It lives here rather than in      │
 * │ mock-provider.ts so that the cleanup query and the audit page can cite it │
 * │ without importing the mock into production code.                          │
 * │                                                                           │
 * │ Changing this string strands every row already carrying the old one. If   │
 * │ it must change, purge first.                                              │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export const SYNTHETIC_MARKER = '[SYNTHETIC]'

// ─────────────────────────────────────────────────────────────────────────────
// Payloads
// ─────────────────────────────────────────────────────────────────────────────

export interface OcrPageInput {
  /** The rendered page image, base64 with no data: prefix. */
  imageBase64: string
  /** Of the image, not of the source document — a PDF page arrives as a PNG. */
  mimeType: string
  /** 1-based, matching document_pages.page_number (0048: `check (> 0)`). */
  pageNumber: number
}

export interface OcrPageResult {
  text: string
  /**
   * 0–1. Lands in document_pages.ocr_confidence, which is `numeric(4,3)` — a
   * fourth decimal is silently rounded by Postgres, so a provider returning
   * more precision than that is storing a number it will not read back.
   */
  confidence: number
  /**
   * Whatever the provider calls the thing that did the work. Free text on
   * purpose: it is provenance, not a vocabulary, and every vendor names its
   * models differently. Lands in document_pages.ocr_model.
   */
  model: string
}

/** One page's text, as extraction sees it. */
export interface ExtractionPage {
  pageNumber: number
  text: string
}

export interface ExtractKnowledgeInput {
  pages: readonly ExtractionPage[]
  /**
   * 0050's closed set, not a free string. Extraction branches on it — a recipe
   * book and a food-safety manual do not yield the same shape of unit — and a
   * kind the CHECK does not admit could never have reached this call anyway.
   */
  documentKind: SourceDocumentKind
}

/**
 * A candidate knowledge unit. Draft, not row: nothing here has an id, a
 * company, or a batch, because those belong to the writer and not the provider.
 */
export interface KnowledgeUnitDraft {
  title: string
  body: string
  /**
   * Which pages this came from, 1-based.
   *
   * Required, and required to be non-empty by whoever writes the row — 0048's
   * central claim is that the page is the unit of provenance, and a unit that
   * cannot name its pages is a claim nobody can check against the cookbook.
   */
  sourcePages: number[]
  /** 0–1, on the same scale as OcrPageResult.confidence. */
  confidence: number
  /** True only for output no human should ever be shown. See SYNTHETIC_MARKER. */
  synthetic: boolean
}

export interface ExtractKnowledgeResult {
  units: KnowledgeUnitDraft[]
  model: string
}

export interface GenerateQuestionsInput {
  units: readonly KnowledgeUnitDraft[]
  /** How many to attempt. A provider may return fewer; it must not return more. */
  count: number
  /**
   * ┌─────────────────────────────────────────────────────────────────────────┐
   * │ `unknown` IS THE HONEST TYPE, AND IT IS NOT LAZINESS.                   │
   * │                                                                         │
   * │ Constraints are what a chef asked for — difficulty mix, categories to   │
   * │ favour, question types to avoid — and that shape belongs to M12's       │
   * │ generation form, which does not exist yet. Typing it now would mean     │
   * │ inventing it here, in the one file that is supposed to own nothing but  │
   * │ the boundary.                                                           │
   * │                                                                         │
   * │ `unknown` rather than `any` because an adapter must then parse it       │
   * │ before it can read it, which is what stops a vendor-shaped object being │
   * │ smuggled through this field and read straight back out the other side.  │
   * └─────────────────────────────────────────────────────────────────────────┘
   */
  constraints: unknown
}

/** One option of a generated question. `label` is what the answer key names. */
export interface GeneratedOptionDraft {
  label: string
  text: string
}

export interface GeneratedQuestionDraft {
  stem: string
  options: GeneratedOptionDraft[]
  /** Must match exactly one `options[].label`. Checked by the writer, not here. */
  correctLabel: string
  explanation: string
  bloomLevel: BloomLevel
  /** Carried through from the units, so a question can still cite its pages. */
  sourcePages: number[]
  synthetic: boolean
}

export interface GenerateQuestionsResult {
  questions: GeneratedQuestionDraft[]
  model: string
}

// ─────────────────────────────────────────────────────────────────────────────
// The provider
// ─────────────────────────────────────────────────────────────────────────────

/**
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ `capabilities` IS A CLAIM THE CALLER MUST CHECK, NOT A GUARANTEE.         │
 * │                                                                           │
 * │ Every provider implements all three methods because TypeScript has no way │
 * │ to make a method conditional on a runtime array. A provider that cannot   │
 * │ do a thing therefore has two options, and only one of them is acceptable: │
 * │ omit the capability and throw ProviderUnavailableError from the method,   │
 * │ or return a plausible-looking answer it did not actually compute.         │
 * │                                                                           │
 * │ The second is how fabricated knowledge reaches a question bank, so the    │
 * │ throw is the contract. resolveProviderFor (./registry) is the caller-side │
 * │ half: it checks the array before handing the provider over, so the throw  │
 * │ is a backstop rather than the ordinary path.                              │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export interface AiProvider {
  /** Stable, lowercase, and the key this provider is registered under. */
  readonly id: string
  readonly capabilities: readonly AiCapability[]

  ocrPage(input: OcrPageInput): Promise<OcrPageResult>
  extractKnowledge(input: ExtractKnowledgeInput): Promise<ExtractKnowledgeResult>
  generateQuestions(input: GenerateQuestionsInput): Promise<GenerateQuestionsResult>
}

export function hasCapability(
  provider: AiProvider,
  capability: AiCapability,
): boolean {
  return (provider.capabilities as readonly string[]).includes(capability)
}

// ─────────────────────────────────────────────────────────────────────────────
// Unavailability
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Why a provider could not be used.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE REASON IS THE WHOLE VALUE OF THIS ERROR.                              │
 * │                                                                           │
 * │ `new Error('AI provider unavailable')` is the version of this that gets   │
 * │ written by default, and it costs a support round trip every single time:  │
 * │ "no key configured" is fixed by an operator in a deployment console, and  │
 * │ "this provider cannot generate" is fixed by a developer choosing another  │
 * │ one. Same message, two different people, and the message tells neither of │
 * │ them which they are.                                                      │
 * │                                                                           │
 * │ So the reason is a closed vocabulary on the instance, and the UI branches │
 * │ on it rather than on the wording of a string.                             │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export const PROVIDER_UNAVAILABLE_REASONS = [
  // The selected provider is registered, but its credential env var is unset.
  // Recoverable by an operator, and never reached through resolveProvider(),
  // which falls back to the mock instead of throwing.
  'no-credential',
  // The provider is usable, but does not do the thing that was asked of it.
  'capability-missing',
  // AI_PROVIDER names an id that is not in PROVIDERS. A typo, or an adapter
  // that was deployed without its registry entry.
  'unknown-provider',
] as const

export type ProviderUnavailableReason = (typeof PROVIDER_UNAVAILABLE_REASONS)[number]

export class ProviderUnavailableError extends Error {
  readonly reason: ProviderUnavailableReason
  /** The id that was asked for — which may not be a registered one. */
  readonly providerId: string
  /** Only set for `capability-missing`; null otherwise. */
  readonly capability: AiCapability | null

  constructor(
    reason: ProviderUnavailableReason,
    providerId: string,
    capability: AiCapability | null = null,
  ) {
    super(messageFor(reason, providerId, capability))
    // Subclass names are not preserved by every bundler's class transform, and
    // a log line reading `Error:` for this is the one thing that would make it
    // indistinguishable from the generic throw it exists to replace.
    this.name = 'ProviderUnavailableError'
    this.reason = reason
    this.providerId = providerId
    this.capability = capability
  }
}

/**
 * The sentence a human reads. Written for whoever has to act on it — each one
 * names the variable or the file that fixes it, because "unavailable" on its
 * own has never told anybody what to do next.
 */
function messageFor(
  reason: ProviderUnavailableReason,
  providerId: string,
  capability: AiCapability | null,
): string {
  switch (reason) {
    case 'no-credential':
      return `AI provider '${providerId}' has no credential configured. Set its key in the deployment environment, or leave AI_PROVIDER unset to run against the mock.`
    case 'capability-missing':
      return `AI provider '${providerId}' does not support '${capability}'. Its capabilities are declared in its adapter; pick a provider that lists this one.`
    case 'unknown-provider':
      return `AI_PROVIDER is set to '${providerId}', which is not registered. Add it to PROVIDERS in src/lib/ai/registry.ts, or correct the value.`
  }
}
