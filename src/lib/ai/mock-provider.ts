import {
  AI_CAPABILITIES,
  SYNTHETIC_MARKER,
  type AiCapability,
  type AiProvider,
  type ExtractKnowledgeInput,
  type ExtractKnowledgeResult,
  type GenerateQuestionsInput,
  type GenerateQuestionsResult,
  type GeneratedQuestionDraft,
  type KnowledgeUnitDraft,
  type OcrPageInput,
  type OcrPageResult,
} from './provider'
import { BLOOM_LEVELS } from '../questions/metadata'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The provider that runs when there is no provider.
 *
 * It exists so the whole pipeline — upload, page split, OCR, extraction,
 * generation, review — can be built, demoed and tested with no key, no
 * network, no cost and no rate limit. Every other property below follows from
 * two decisions.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ DETERMINISTIC, AND Math.random WOULD HAVE BROKEN MORE THAN THE TESTS.     │
 * │                                                                           │
 * │ The obvious mock returns random text of random length with a random       │
 * │ confidence. That version cannot answer the question the mock exists to    │
 * │ answer: "did the pipeline actually run over this document, or am I        │
 * │ looking at the last run's rows?" With a seeded hash of the input, the     │
 * │ same page produces the same bytes forever, so a row that differs is a row │
 * │ something changed.                                                        │
 * │                                                                           │
 * │ It also makes the unit suite mean something. A flaky assertion gets       │
 * │ deleted within a month, and the deleted assertion is always the one that  │
 * │ was checking the interesting part.                                        │
 * │                                                                           │
 * │ Nothing here reads Math.random, Date.now, crypto, or a module-level       │
 * │ counter, and nothing sleeps: fake latency is nondeterminism with a        │
 * │ friendly name, and it would add real seconds to every suite that runs.    │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ OBVIOUSLY FAKE, NEVER MERELY PLAUSIBLE.                                   │
 * │                                                                           │
 * │ The tempting mock returns believable cookery — "Sear the protein at 220°C │
 * │ for 90 seconds" — because it demos beautifully. That output is a hazard:  │
 * │ a knowledge unit is a claim about what the company's own cookbook says,   │
 * │ and a plausible invented one is indistinguishable from a real extraction  │
 * │ the moment it lands in the bank. A chef then approves it, it is drawn     │
 * │ onto a paper, and somebody is marked wrong for disagreeing with a         │
 * │ sentence no cookbook ever contained.                                      │
 * │                                                                           │
 * │ So every string is prefixed with SYNTHETIC_MARKER, says in plain English  │
 * │ that it is not real, and carries `synthetic: true`. The marker is the     │
 * │ purge handle after the insert has thrown the flag away — see provider.ts. │
 * │ `model` is MOCK_MODEL for the same reason: document_pages.ocr_model gives │
 * │ the sweep a second, independent way to find these rows.                   │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */

export const MOCK_PROVIDER_ID = 'mock'

/**
 * Deliberately not shaped like anybody's model name — no vendor, no version
 * that could be mistaken for a release, and a slash so it sorts apart from
 * real values in `select distinct ocr_model`.
 */
export const MOCK_MODEL = 'mock/deterministic-v1'

/**
 * The confidence band the mock reports: 0.100–0.399, three decimals.
 *
 * Three decimals because ocr_confidence is `numeric(4,3)` (0048) and a fourth
 * would be rounded away, so the value read back would not equal the value
 * returned — which is exactly the kind of silent difference a determinism test
 * exists to catch.
 *
 * Held in thousandths, and divided exactly once, because the arithmetic that
 * reads better does not survive binary floating point:
 *
 *     0.1 + 299 / 1000   ->  0.39899999999999997
 *     (100 + 299) / 1000 ->  0.399
 *
 * The first is not a three-decimal number and would round to a different value
 * than the one this file claims to produce.
 *
 * Low on purpose. Any quality gate worth having refuses a page under about a
 * half, so mock output stays visibly poor rather than quietly passing as a
 * clean scan.
 */
const MOCK_CONFIDENCE_FLOOR_MILLI = 100
const MOCK_CONFIDENCE_SPREAD_MILLI = 300

/**
 * Ceiling on questions per call.
 *
 * Not a policy about how many questions a generation batch may contain — that
 * belongs to M12 — but a bound on what one mock call will allocate. A caller
 * passing a bad count gets a short list rather than a hung process, which
 * follows moveItem (src/lib/exams/history.ts): clamp and return, do not throw,
 * because a mock refusing to run is a worse debugging experience than a mock
 * returning less than asked.
 */
const MOCK_MAX_QUESTIONS = 50

/** Four options, labelled the way every paper in the product labels them. */
const MOCK_OPTION_LABELS = ['A', 'B', 'C', 'D'] as const

export class MockAiProvider implements AiProvider {
  readonly id = MOCK_PROVIDER_ID
  /**
   * All three. A mock that could only do part of the pipeline would leave the
   * rest of it unreachable without a key, which is the whole thing this class
   * is for.
   */
  readonly capabilities: readonly AiCapability[] = AI_CAPABILITIES

  async ocrPage(input: OcrPageInput): Promise<OcrPageResult> {
    const seed = seedOf('ocr', String(input.pageNumber), input.mimeType, sample(input.imageBase64))

    return {
      text: [
        `${SYNTHETIC_MARKER} No text was read from page ${input.pageNumber}.`,
        `This placeholder was produced by the mock AI provider because no real one is configured.`,
        `It is not the contents of the document. seed=${seed} mime=${input.mimeType}`,
      ].join(' '),
      confidence: confidenceFrom(seed),
      model: MOCK_MODEL,
    }
  }

  async extractKnowledge(input: ExtractKnowledgeInput): Promise<ExtractKnowledgeResult> {
    const pageNumbers = input.pages.map((page) => page.pageNumber)
    const seed = seedOf(
      'extract',
      input.documentKind,
      pageNumbers.join(','),
      String(input.pages.reduce((total, page) => total + page.text.length, 0)),
    )

    // One to three, so a caller can see a list render rather than a single row,
    // without the count being a number anybody could mistake for a real yield.
    const wanted = input.pages.length === 0 ? 0 : 1 + (seed % 3)

    const units: KnowledgeUnitDraft[] = []
    for (let index = 0; index < wanted; index += 1) {
      // Cite real page numbers from the real input. The provenance path has to
      // be exercised by the mock or it is only ever tested with a live key.
      const page = input.pages[index % input.pages.length]
      units.push({
        title: `${SYNTHETIC_MARKER} Placeholder unit ${index + 1} of ${wanted} (${input.documentKind})`,
        body: [
          `${SYNTHETIC_MARKER} This unit states nothing about the document it claims to come from.`,
          `It was generated from page ${page.pageNumber} by the mock AI provider and must be purged`,
          `before any real extraction is trusted. seed=${seed}`,
        ].join(' '),
        sourcePages: [page.pageNumber],
        confidence: confidenceFrom(seed + index),
        synthetic: true,
      })
    }

    return { units, model: MOCK_MODEL }
  }

  async generateQuestions(input: GenerateQuestionsInput): Promise<GenerateQuestionsResult> {
    const seed = seedOf(
      'generate',
      String(input.count),
      String(input.units.length),
      input.units.map((unit) => unit.title).join('|'),
    )

    // Every page any unit cited, deduplicated and ordered, so a generated
    // question can still be traced back to the scan it came from.
    const sourcePages = [...new Set(input.units.flatMap((unit) => unit.sourcePages))].sort(
      (a, b) => a - b,
    )

    const wanted = Math.min(Math.max(Math.trunc(input.count), 0), MOCK_MAX_QUESTIONS)

    const questions: GeneratedQuestionDraft[] = []
    for (let index = 0; index < wanted; index += 1) {
      const questionSeed = seed + index
      const correctLabel = MOCK_OPTION_LABELS[questionSeed % MOCK_OPTION_LABELS.length]

      questions.push({
        stem: [
          `${SYNTHETIC_MARKER} Placeholder question ${index + 1} of ${wanted}.`,
          `This is not a question about anything; it was produced by the mock AI provider`,
          `from ${input.units.length} synthetic unit(s) and must never be published. seed=${questionSeed}`,
        ].join(' '),
        options: MOCK_OPTION_LABELS.map((label) => ({
          label,
          text: `${SYNTHETIC_MARKER} Option ${label} — not an answer to anything.`,
        })),
        correctLabel,
        explanation: `${SYNTHETIC_MARKER} Option ${correctLabel} is "correct" only because the seed selected it. There is no reasoning behind this key.`,
        // Cycled rather than fixed, so a distribution chart built against mock
        // data shows every bar and not one spike at `remember`.
        bloomLevel: BLOOM_LEVELS[questionSeed % BLOOM_LEVELS.length],
        sourcePages,
        synthetic: true,
      })
    }

    return { questions, model: MOCK_MODEL }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The seed
// ─────────────────────────────────────────────────────────────────────────────

const FNV_OFFSET_BASIS = 0x811c9dc5
const FNV_PRIME = 0x01000193

/**
 * FNV-1a, 32-bit.
 *
 * A seed, not a digest: it needs to be stable across processes and platforms
 * and nothing else, so a hand-written twenty-line function beats a dependency
 * that would have to be audited and kept current for no security benefit.
 *
 * `Math.imul` because plain `*` on a 32-bit-scale product silently promotes to
 * a double and loses the low bits — the classic way a "deterministic" hash
 * ends up disagreeing with itself once the input gets long.
 */
function hash32(input: string): number {
  let value = FNV_OFFSET_BASIS
  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index)
    value = Math.imul(value, FNV_PRIME)
  }
  // Unsigned, so `%` below can never be handed a negative and produce a
  // negative index or a negative confidence.
  return value >>> 0
}

/**
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHY THE PARTS ARE JOINED BY HAND AND NOT BY JSON.stringify.               │
 * │                                                                           │
 * │ JSON.stringify serialises object keys in insertion order, so two callers  │
 * │ building the same logical input in a different field order would hash     │
 * │ differently and the mock would stop being deterministic in exactly the    │
 * │ case nobody tests — a refactor of a call site.                            │
 * │                                                                           │
 * │ Joining a fixed list of strings, in an order this file chooses, with a    │
 * │ separator that cannot occur in the parts, makes the serialisation this    │
 * │ file's decision rather than the caller's.                                 │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
function seedOf(...parts: string[]): number {
  return hash32(parts.join(' '))
}

/**
 * The first 256 characters plus the length.
 *
 * A rendered page image is megabytes of base64, and hashing all of it on every
 * call is real CPU spent to distinguish inputs that the prefix and the length
 * already distinguish. Two different pages colliding here would produce two
 * identical pieces of text that both say they are fake, which is not a failure
 * mode worth a full pass over the buffer.
 */
function sample(value: string): string {
  return `${value.length}:${value.slice(0, 256)}`
}

/** 0.100–0.399, to exactly three decimals. See MOCK_CONFIDENCE_FLOOR_MILLI. */
function confidenceFrom(seed: number): number {
  const offset = Math.abs(seed) % MOCK_CONFIDENCE_SPREAD_MILLI
  return (MOCK_CONFIDENCE_FLOOR_MILLI + offset) / 1000
}
