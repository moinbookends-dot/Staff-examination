import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  AI_CAPABILITIES,
  BATCH_KIND_FOR_CAPABILITY,
  PROVIDER_UNAVAILABLE_REASONS,
  ProviderUnavailableError,
  SYNTHETIC_MARKER,
  type AiCapability,
  type AiProvider,
  type ExtractKnowledgeInput,
  type GenerateQuestionsInput,
  type KnowledgeUnitDraft,
  type OcrPageInput,
} from '../../src/lib/ai/provider'
import {
  MOCK_MODEL,
  MOCK_PROVIDER_ID,
  MockAiProvider,
} from '../../src/lib/ai/mock-provider'
import {
  PROVIDERS,
  isAiConfigured,
  resolveProvider,
  resolveProviderFor,
} from '../../src/lib/ai/registry'

/**
 * The AI provider boundary: determinism, synthetic marking, and selection.
 *
 * Two assertions carry this file, and both are the ones that would be dropped
 * first if somebody were shortening it.
 *
 * The first is that the mock answers DIFFERENTLY for a different page. Without
 * it, every determinism test passes against a mock that returns one fixed
 * string for everything — and a mock like that answers "did the pipeline run
 * over this document?" with a permanent, confident yes.
 *
 * The second is the credential-present half of the fallback pair. On its own,
 * "no credential -> mock" passes against a resolveProvider that has forgotten
 * how to return anything but the mock, which is the failure that would send a
 * real cookbook through synthetic OCR with the batch reporting success. Both
 * halves, or neither means anything — the argument is the one stated in
 * tests/integration/question-status-parity.test.ts.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHY THIS FILE WRITES INTO PROVIDERS, WHICH IS OTHERWISE NOBODY'S JOB.     │
 * │                                                                           │
 * │ There is exactly one provider in the tree, and it is the mock. Testing    │
 * │ "resolveProvider honours AI_PROVIDER" needs a second one, and the only    │
 * │ other way to get one is to add a vendor adapter — putting a vendor name   │
 * │ into src/ for no reason other than to give a test something to select.    │
 * │                                                                           │
 * │ So the second provider is registered here, in the test, and removed in    │
 * │ afterEach. It is also the closest thing to a proof of the one-entry claim │
 * │ in registry.ts's header: this file adds a provider with one object        │
 * │ literal and changes nothing else, which is exactly what an adapter is     │
 * │ supposed to cost.                                                         │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

// ── Fixtures ─────────────────────────────────────────────────────────────────

const pageInput: OcrPageInput = {
  imageBase64: 'aGVsbG8sIHBhZ2U=',
  mimeType: 'image/png',
  pageNumber: 7,
}

const extractionInput: ExtractKnowledgeInput = {
  documentKind: 'cookbook',
  pages: [
    { pageNumber: 11, text: 'brine the bird overnight' },
    { pageNumber: 12, text: 'rest for twenty minutes' },
  ],
}

const units: KnowledgeUnitDraft[] = [
  {
    title: 'a unit',
    body: 'a body',
    sourcePages: [12, 11],
    confidence: 0.9,
    synthetic: false,
  },
  {
    title: 'another unit',
    body: 'another body',
    sourcePages: [11],
    confidence: 0.8,
    synthetic: false,
  },
]

const generationInput: GenerateQuestionsInput = {
  units,
  count: 3,
  constraints: { anything: true },
}

// ── The second provider ──────────────────────────────────────────────────────

const DOUBLE_ID = 'test-double'
const DOUBLE_CREDENTIAL = 'TEST_DOUBLE_AI_KEY'

/** Declares only 'ocr', so resolveProviderFor has something to refuse. */
const PARTIAL_ID = 'test-double-ocr-only'
const PARTIAL_CREDENTIAL = 'TEST_DOUBLE_OCR_KEY'

/**
 * Every method throws. Selection is what these doubles exist to exercise, and
 * a method that returned a plausible value would let a test pass while the
 * wrong provider was doing the work.
 */
function makeDouble(id: string, capabilities: readonly AiCapability[]): AiProvider {
  const refuse = (method: string) => async (): Promise<never> => {
    throw new Error(`${id}.${method} must never be called by a selection test.`)
  }
  return {
    id,
    capabilities,
    ocrPage: refuse('ocrPage'),
    extractKnowledge: refuse('extractKnowledge'),
    generateQuestions: refuse('generateQuestions'),
  }
}

/**
 * The error a call threw, or null if it did not throw.
 *
 * `expect(...).toThrow(Class)` proves the type and stops there; every
 * assertion this file cares about is on the fields the error carries, and
 * re-running the call inside a catch block to reach them would run the thing
 * under test twice with the second run unasserted.
 */
function thrownBy(run: () => unknown): ProviderUnavailableError | null {
  try {
    run()
    return null
  } catch (error) {
    return error as ProviderUnavailableError
  }
}

const ENV_KEYS = ['AI_PROVIDER', DOUBLE_CREDENTIAL, PARTIAL_CREDENTIAL]

let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = {}
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key]
    delete process.env[key]
  }

  PROVIDERS[DOUBLE_ID] = {
    credentialEnvVar: DOUBLE_CREDENTIAL,
    create: () => makeDouble(DOUBLE_ID, AI_CAPABILITIES),
  }
  PROVIDERS[PARTIAL_ID] = {
    credentialEnvVar: PARTIAL_CREDENTIAL,
    create: () => makeDouble(PARTIAL_ID, ['ocr']),
  }
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  delete PROVIDERS[DOUBLE_ID]
  delete PROVIDERS[PARTIAL_ID]
})

describe('the mock provider is deterministic', () => {
  it('reads the same page the same way, from a fresh instance', async () => {
    const first = await new MockAiProvider().ocrPage(pageInput)
    const second = await new MockAiProvider().ocrPage(pageInput)

    // Two instances, not one called twice: a mock that memoised its answers
    // would satisfy the second form and still differ across a server restart,
    // which is the case that matters.
    expect(second).toEqual(first)
  })

  it('extracts the same units from the same pages', async () => {
    const first = await new MockAiProvider().extractKnowledge(extractionInput)
    const second = await new MockAiProvider().extractKnowledge(extractionInput)

    expect(second).toEqual(first)
  })

  it('generates the same questions from the same units', async () => {
    const first = await new MockAiProvider().generateQuestions(generationInput)
    const second = await new MockAiProvider().generateQuestions(generationInput)

    expect(second).toEqual(first)
  })

  /**
   * ┌─────────────────────────────────────────────────────────────────────────┐
   * │ THE POSITIVE CONTROL FOR THE THREE TESTS ABOVE.                         │
   * │                                                                         │
   * │ A mock that ignored its input entirely and returned one constant is     │
   * │ perfectly deterministic, passes all three, and is worthless: the point  │
   * │ of seeding from the input is that a row which differs is a row          │
   * │ something changed. This is the assertion that says the seed is real.    │
   * └─────────────────────────────────────────────────────────────────────────┘
   */
  it('does not give every page the same answer', async () => {
    const provider = new MockAiProvider()
    const seven = await provider.ocrPage(pageInput)
    const eight = await provider.ocrPage({ ...pageInput, pageNumber: 8 })

    expect(eight.text).not.toBe(seven.text)
  })

  it('reports a confidence that ocr_confidence can store without rounding', async () => {
    const result = await new MockAiProvider().ocrPage(pageInput)

    expect(result.confidence).toBeGreaterThanOrEqual(0)
    expect(result.confidence).toBeLessThanOrEqual(1)
    // numeric(4,3): a fourth decimal is rounded away by Postgres, so a value
    // that does not survive its own toFixed(3) is a value the column will
    // silently change on the way in.
    expect(Number(result.confidence.toFixed(3))).toBe(result.confidence)
  })
})

describe('the mock provider marks everything it invents', () => {
  it('has a marker to look for', () => {
    // Meta-guard: with an empty marker every `toContain` below passes against
    // output carrying no marking at all.
    expect(SYNTHETIC_MARKER.trim().length).toBeGreaterThan(0)
  })

  it('says so in the OCR text, and again in the model', async () => {
    const result = await new MockAiProvider().ocrPage(pageInput)

    expect(result.text).toContain(SYNTHETIC_MARKER)
    // The marker survives into ocr_text; the model name is the second, wholly
    // independent way to find these rows once somebody is holding psql.
    expect(result.model).toBe(MOCK_MODEL)
  })

  it('marks every knowledge unit, in the flag and in the prose', async () => {
    const result = await new MockAiProvider().extractKnowledge(extractionInput)

    expect(result.units.length).toBeGreaterThan(0)
    for (const unit of result.units) {
      expect(unit.synthetic, unit.title).toBe(true)
      expect(unit.title).toContain(SYNTHETIC_MARKER)
      expect(unit.body).toContain(SYNTHETIC_MARKER)
    }
  })

  it('marks every generated question, including each option', async () => {
    const result = await new MockAiProvider().generateQuestions(generationInput)

    expect(result.questions).toHaveLength(generationInput.count)
    for (const question of result.questions) {
      expect(question.synthetic, question.stem).toBe(true)
      expect(question.stem).toContain(SYNTHETIC_MARKER)
      expect(question.explanation).toContain(SYNTHETIC_MARKER)
      for (const option of question.options) {
        expect(option.text, option.label).toContain(SYNTHETIC_MARKER)
      }
      // The key names an option that exists, so a mock run can be inserted and
      // reviewed rather than failing at the answer-key write.
      expect(question.options.map((option) => option.label)).toContain(question.correctLabel)
    }
  })

  it('keeps the pages a unit cited, so provenance is exercised without a key', async () => {
    const result = await new MockAiProvider().generateQuestions(generationInput)

    // Deduplicated and ordered, out of the units' own page lists — not invented.
    expect(result.questions[0].sourcePages).toEqual([11, 12])
  })

  it('offers all three capabilities, so no stage needs a key to be reachable', () => {
    const provider = new MockAiProvider()
    for (const capability of AI_CAPABILITIES) {
      expect(provider.capabilities, capability).toContain(capability)
    }
  })
})

describe('resolveProvider', () => {
  it('runs the mock when AI_PROVIDER is unset', () => {
    expect(resolveProvider().id).toBe(MOCK_PROVIDER_ID)
  })

  it('falls back to the mock when the selected provider has no credential', () => {
    process.env.AI_PROVIDER = DOUBLE_ID

    expect(resolveProvider().id).toBe(MOCK_PROVIDER_ID)
  })

  /**
   * ┌─────────────────────────────────────────────────────────────────────────┐
   * │ THE POSITIVE CONTROL FOR THE FALLBACK.                                  │
   * │                                                                         │
   * │ Identical setup to the test above except that the key exists. Without   │
   * │ this half, "falls back to the mock" is also satisfied by a              │
   * │ resolveProvider that returns the mock unconditionally — and that        │
   * │ version ships silently, because the mock is the only registered         │
   * │ provider in this tree and every other test would still pass.            │
   * └─────────────────────────────────────────────────────────────────────────┘
   */
  it('honours AI_PROVIDER once the credential is present', () => {
    process.env.AI_PROVIDER = DOUBLE_ID
    process.env[DOUBLE_CREDENTIAL] = 'a-credential'

    expect(resolveProvider().id).toBe(DOUBLE_ID)
  })

  it('treats a blank credential as no credential', () => {
    process.env.AI_PROVIDER = DOUBLE_ID
    // How a key is "removed" in every deployment console there is. Treating it
    // as present sends the request out with an empty header and surfaces as a
    // 401 from the vendor, three layers from the cause.
    process.env[DOUBLE_CREDENTIAL] = '   '

    expect(resolveProvider().id).toBe(MOCK_PROVIDER_ID)
  })

  it('refuses an AI_PROVIDER nobody registered instead of falling back', () => {
    process.env.AI_PROVIDER = 'not-registered'

    // A typo must not run the mock over a real cookbook while the batch
    // reports success. See the box in registry.ts.
    const error = thrownBy(() => resolveProvider())

    expect(error).toBeInstanceOf(ProviderUnavailableError)
    expect(error?.reason).toBe('unknown-provider')
    expect(error?.providerId).toBe('not-registered')
  })
})

describe('resolveProviderFor', () => {
  it('hands over a provider that declares the capability', () => {
    process.env.AI_PROVIDER = PARTIAL_ID
    process.env[PARTIAL_CREDENTIAL] = 'a-credential'

    expect(resolveProviderFor('ocr').id).toBe(PARTIAL_ID)
  })

  it('refuses before any work starts when the capability is missing', () => {
    process.env.AI_PROVIDER = PARTIAL_ID
    process.env[PARTIAL_CREDENTIAL] = 'a-credential'

    const error = thrownBy(() => resolveProviderFor('generate'))

    expect(error).toBeInstanceOf(ProviderUnavailableError)
    expect(error?.reason).toBe('capability-missing')
    expect(error?.providerId).toBe(PARTIAL_ID)
    expect(error?.capability).toBe('generate')
  })
})

describe('isAiConfigured', () => {
  it('is false with nothing configured', () => {
    expect(isAiConfigured()).toBe(false)
  })

  it('is false when the mock was chosen deliberately', () => {
    // The UI is asking "will anything real happen if I press Generate?", and
    // the honest answer to that is no in both cases.
    process.env.AI_PROVIDER = MOCK_PROVIDER_ID

    expect(isAiConfigured()).toBe(false)
  })

  it('is false when the selected provider has no credential', () => {
    process.env.AI_PROVIDER = DOUBLE_ID

    expect(isAiConfigured()).toBe(false)
  })

  it('is true once a real provider has its credential', () => {
    process.env.AI_PROVIDER = DOUBLE_ID
    process.env[DOUBLE_CREDENTIAL] = 'a-credential'

    expect(isAiConfigured()).toBe(true)
  })

  it('answers rather than throwing for an id nobody registered', () => {
    process.env.AI_PROVIDER = 'not-registered'

    // resolveProvider throws for this; this one must not, because it is called
    // to decide whether to render a warning strip and a typo in an env var
    // must not take the page down with it.
    expect(isAiConfigured()).toBe(false)
  })
})

describe('ProviderUnavailableError', () => {
  it('carries a reason from the vocabulary, not just a sentence', () => {
    const error = new ProviderUnavailableError('no-credential', 'somebody')

    expect(PROVIDER_UNAVAILABLE_REASONS).toContain(error.reason)
    expect(error.reason).toBe('no-credential')
    expect(error.providerId).toBe('somebody')
    expect(error.capability).toBeNull()
  })

  it('carries the capability when that is what was missing', () => {
    const error = new ProviderUnavailableError('capability-missing', 'somebody', 'extract')

    expect(error.capability).toBe('extract')
  })

  it('is still an Error, and still says which one it is in a log line', () => {
    const error = new ProviderUnavailableError('unknown-provider', 'typo')

    expect(error).toBeInstanceOf(Error)
    // Asserted by name as well as by instanceof: a class transform that drops
    // the subclass name leaves every one of these logging as a bare `Error`,
    // which is the generic throw this class exists to replace.
    expect(error.name).toBe('ProviderUnavailableError')
    expect(error.message).toContain('typo')
  })

  it('tells whoever reads it what to change', () => {
    // Each reason names the variable or the file that fixes it. "Provider
    // unavailable" costs a support round trip every time, because an operator
    // and a developer fix different halves of it.
    expect(new ProviderUnavailableError('no-credential', 'x').message).toContain('AI_PROVIDER')
    expect(new ProviderUnavailableError('unknown-provider', 'x').message).toContain(
      'src/lib/ai/registry.ts',
    )
  })
})

describe('BATCH_KIND_FOR_CAPABILITY', () => {
  it('maps every capability onto a kind import_batches admits', () => {
    // The trap this exists for: two of the three words differ from the SQL
    // CHECK, so `kind: capability` compiles, inserts `extract`, and returns a
    // bare 23514 with the bytes already in the bucket.
    const expected: Record<AiCapability, string> = {
      ocr: 'ocr',
      extract: 'extraction',
      generate: 'generation',
    }
    for (const capability of AI_CAPABILITIES) {
      expect(BATCH_KIND_FOR_CAPABILITY[capability], capability).toBe(expected[capability])
    }
  })
})
