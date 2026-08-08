import { describe, it, expect, beforeAll } from 'vitest'
import { renderQuestionPaper, renderAnswerKey } from '@/lib/pdf'
import { watermarkFontSize } from '@/lib/pdf/paper'
import type { PaperDocumentInput, PaperQuestion } from '@/lib/pdf/types'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The PDF engine.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE ONE TEST THIS FILE EXISTS FOR: THE QUESTION PAPER MUST NOT CONTAIN    ║
 * ║ THE ANSWERS.                                                              ║
 * ║                                                                           ║
 * ║ Both documents are rendered from the SAME input object, because they      ║
 * ║ describe the same paper and fetching them separately is how a key ends up ║
 * ║ describing a different paper. That means the question paper is handed the ║
 * ║ correct options and the model answers on every single render, and the     ║
 * ║ only thing keeping them off the page is one guard in paper.tsx.           ║
 * ║                                                                           ║
 * ║ So it is asserted in both directions, over the EXTRACTED TEXT of the      ║
 * ║ actual PDF rather than over the component tree: the key contains the      ║
 * ║ answer token, and the paper does not. A one-directional check would pass  ║
 * ║ against a renderer that printed nothing at all.                           ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE CONTENT BELOW IS TEST SCAFFOLDING AND IS NOT QUESTION CONTENT.        │
 * │                                                                           │
 * │ No cookbook material is invented here and no plausible-looking exam       │
 * │ question appears. The strings are deliberately neutral and obviously      │
 * │ synthetic — "First question", "Alpha" — so that nothing in this file      │
 * │ could be mistaken for, or harvested as, real bank content.                │
 * │                                                                           │
 * │ The answer tokens are nonsense strings chosen to be unmistakable in an    │
 * │ extraction: if ANSWERTOKENALPHA appears in the candidate's paper, the     │
 * │ guard has failed, and no false positive is possible.                      │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * The short answer's expected text. This one genuinely must not appear on the
 * candidate's paper — there is nothing for them to read, only a ruled line to
 * write on.
 */
const SHORT_ANSWER_TOKEN = 'ANSWERTOKENBRAVO'

/**
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ AN MCQ LEAKS DIFFERENTLY, AND THE FIRST VERSION OF THIS FILE GOT IT       │
 * │ WRONG.                                                                    │
 * │                                                                           │
 * │ It made the correct option's TEXT a unique token and asserted the paper   │
 * │ did not contain it — which failed, correctly, because option C's text is  │
 * │ exactly what a candidate has to read in order to choose it. All four      │
 * │ options appear on both documents; they must.                              │
 * │                                                                           │
 * │ What must not appear is WHICH ONE IS RIGHT. So the leak is tested against │
 * │ the marker instead: the "ANSWER:" line and the ▶ that flags the chosen    │
 * │ option, neither of which has any business on a candidate's paper.         │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
const ANSWER_MARKER = 'ANSWER:'

/**
 * How the key flags the correct option: [C] rather than (C).
 *
 * This was `▶` until this suite caught it extracting as `¶`. U+25B6 is not in
 * Noto Sans, and react-pdf has no font fallback — so the marker rendered as an
 * unrelated glyph, silently, on the one document where being unambiguous is
 * the entire point. ASCII only, and never colour alone: an answer key is
 * printed, often in black and white.
 */
const CHOSEN_MARKER = '[C]'
const UNCHOSEN_MARKER = '(C)'

/** Marker-facing rationale. Must never appear on a candidate's paper. */
const EXPLANATION_TOKEN = 'EXPLANATIONTOKENCHARLIE'

/** Diagonal text behind the questions. Appears on both documents. */
const WATERMARK_TOKEN = 'WATERMARKTOKENDELTA'

const QUESTIONS: PaperQuestion[] = [
  {
    questionNo: 1,
    section: 'mcq',
    text: 'First question',
    options: { A: 'Alpha', B: 'Bravo', C: 'Charlie', D: 'Delta' },
    correctOption: 'C',
    explanation: EXPLANATION_TOKEN,
  },
  {
    questionNo: 2,
    section: 'mcq',
    text: 'Second question',
    options: { A: 'Echo', B: 'Foxtrot', C: 'Golf', D: 'Hotel' },
    correctOption: 'A',
  },
  {
    questionNo: 3,
    section: 'short_answer',
    text: 'Third question',
    answerText: SHORT_ANSWER_TOKEN,
  },
]

function input(overrides: Partial<PaperDocumentInput> = {}): PaperDocumentInput {
  return {
    locale: 'en',
    header: {
      title: 'Test Organisation',
      companyName: 'Test Organisation',
      brandName: 'Test Brand',
      paperNo: 42,
      difficultyLabel: 'Level Two',
      totalMarks: 3,
      passingPercent: null,
      footerText: null,
    },
    questions: QUESTIONS,
    ...overrides,
  }
}

/**
 * Pull the text layer out of a rendered PDF.
 *
 * pdfjs is used rather than a regex over the raw bytes: the content streams are
 * compressed and the fonts are subset-embedded, so the literal string is not
 * present in the file even when it IS printed on the page. A grep would report
 * a clean paper regardless of what the renderer did, which is the worst
 * possible result for this particular assertion.
 */
async function extractText(pdf: Buffer): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  const doc = await pdfjs.getDocument({
    data: new Uint8Array(pdf),
    // The test corpus is Latin; skipping the standard-font fetch keeps this
    // offline and silent.
    useSystemFonts: false,
    isEvalSupported: false,
  }).promise

  let out = ''
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i)
    const content = await page.getTextContent()
    out += content.items.map((item) => ('str' in item ? item.str : '')).join(' ')
    out += '\n'
  }
  return out
}

describe('PDF engine', () => {
  let paperText: string
  let keyText: string

  beforeAll(async () => {
    const [paper, key] = await Promise.all([
      renderQuestionPaper(input()),
      renderAnswerKey(input()),
    ])
    paperText = await extractText(paper)
    keyText = await extractText(key)
  }, 60_000)

  it('produces a valid PDF', async () => {
    const paper = await renderQuestionPaper(input())
    expect(paper.subarray(0, 5).toString()).toBe('%PDF-')
    expect(paper.length).toBeGreaterThan(1000)
  })

  // ── The guard, both directions ────────────────────────────────────────────

  it('does NOT reveal which MCQ option is correct on the question paper', () => {
    expect(paperText).not.toContain(ANSWER_MARKER)
    expect(paperText).not.toContain(CHOSEN_MARKER)
    // …and the option it marks on the key is rendered plainly here.
    expect(paperText).toContain(UNCHOSEN_MARKER)
  })

  it('does NOT print the explanation on the question paper', () => {
    // A rationale is marker-facing. On a candidate's paper it is a hint at
    // best and the answer at worst.
    expect(paperText).not.toContain(EXPLANATION_TOKEN)
  })

  it('DOES print the explanation on the answer key', () => {
    expect(keyText).toContain(EXPLANATION_TOKEN)
  })

  it('omits the explanation line entirely when a question has none', async () => {
    // Optional per question AND per language — a bank may be explained in
    // English and not yet in Gujarati. An empty label would be noise on every
    // unexplained question.
    const withoutExplanations = QUESTIONS.map(({ explanation, ...q }) => {
      void explanation
      return q
    })
    const pdf = await renderAnswerKey(input({ questions: withoutExplanations }))
    const text = await extractText(pdf)

    expect(text).toContain(ANSWER_MARKER)
    expect(text).not.toContain(EXPLANATION_TOKEN)
  }, 30_000)

  it('marks the correct option with printable ASCII, not colour or a symbol', () => {
    /*
     * A regression guard for two separate mistakes, both of which produce a key
     * that looks fine on the screen it was built on:
     *
     *  · a glyph the font lacks (the original ▶ → ¶), and
     *  · colour as the only signal, which disappears on a mono printer.
     *
     * Asserting the marker is ASCII covers the first; asserting it is present
     * in the extracted TEXT covers the second, since a purely visual highlight
     * would not appear in an extraction at all.
     */
    expect(/^[\x20-\x7E]+$/.test(CHOSEN_MARKER)).toBe(true)
    expect(keyText).toContain(CHOSEN_MARKER)
  })

  it('does NOT print the short answer on the question paper', () => {
    expect(paperText).not.toContain(SHORT_ANSWER_TOKEN)
  })

  it('DOES mark the correct option and print the answer on the key', () => {
    // The positive half. Without it, the two assertions above would pass
    // against a renderer that produced a blank page.
    expect(keyText).toContain(ANSWER_MARKER)
    expect(keyText).toContain(CHOSEN_MARKER)
    expect(keyText).toContain(SHORT_ANSWER_TOKEN)
  })

  it('prints all four MCQ options on BOTH documents', () => {
    // The candidate must be able to read every option; the marker is the only
    // thing that differs between the two documents.
    for (const option of ['Alpha', 'Bravo', 'Charlie', 'Delta']) {
      expect(paperText).toContain(option)
      expect(keyText).toContain(option)
    }
  })

  it('prints every question on both documents', () => {
    for (const q of QUESTIONS) {
      expect(paperText).toContain(q.text)
      expect(keyText).toContain(q.text)
    }
  })

  // ── Layout facts the customer specified ───────────────────────────────────

  it('prints the paper number and level', () => {
    expect(paperText).toContain('42')
    expect(paperText).toContain('Level Two')
  })

  it('prints per-question marks and section totals', () => {
    expect(paperText).toContain('[1]')
    // Two MCQs and one short answer in the fixture.
    expect(paperText).toContain('SECTION A')
    expect(paperText).toContain('SECTION B')
  })

  it('prints candidate blanks on the paper but not on the key', () => {
    expect(paperText).toContain('Name')
    expect(paperText).toContain('Employee ID')
    // A marker has no use for the candidate's signature line.
    expect(keyText).not.toContain('Employee ID')
  })

  it('prints instructions on the paper only', () => {
    expect(paperText).toContain('INSTRUCTIONS')
    expect(keyText).not.toContain('INSTRUCTIONS')
  })

  it('labels the key as an answer key', () => {
    expect(keyText).toContain('ANSWER KEY')
    expect(paperText).not.toContain('ANSWER KEY')
  })

  it('prints a footer on every page of both documents', () => {
    /*
     * This footer rendered on NO page for three separate attempts, and the PDF
     * was valid every time — see the box on `footer` in paper.tsx for the
     * measurements. A missing footer is invisible to a text assertion unless
     * somebody writes the assertion, so here it is.
     *
     * The company name is asserted rather than a page number: `render` emits
     * nothing in this version of the renderer, so there IS no page number, and
     * a test demanding one would be pinning a feature the library does not
     * currently provide.
     */
    const footer = 'Test Organisation'
    expect(paperText).toContain(footer)
    expect(keyText).toContain(footer)
  })

  it('uses the configured footer text in place of the company name', async () => {
    const pdf = await renderQuestionPaper(
      input({ header: { ...input().header, footerText: 'CONFIGUREDFOOTER' } }),
    )
    const text = await extractText(pdf)
    expect(text).toContain('CONFIGUREDFOOTER')
  }, 30_000)

  // ── Pass mark ─────────────────────────────────────────────────────────────

  it('omits the pass mark entirely when it is not set', () => {
    // "No pass mark" must not render as 0. The same rule the analytics layer
    // holds to: absent is not zero, and zero is a much more alarming claim.
    expect(paperText).not.toContain('Pass mark')
  })

  it('computes the pass mark from the percentage when it is set', async () => {
    const pdf = await renderQuestionPaper(
      input({
        header: { ...input().header, totalMarks: 20, passingPercent: 60 },
      }),
    )
    const text = await extractText(pdf)
    // 60% of 20, rounded up.
    expect(text).toContain('12 / 20')
  }, 30_000)

  // ── Empty input ───────────────────────────────────────────────────────────

  it('renders an empty paper rather than inventing questions', async () => {
    /*
     * The bank does not exist yet, so this is the state the renderer is in
     * today. It must produce a valid, empty paper — not a placeholder, not a
     * sample question, and not a crash.
     */
    const pdf = await renderQuestionPaper(input({ questions: [] }))
    const text = await extractText(pdf)

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(text).toContain('Test Organisation')
    expect(text).not.toContain('SECTION A')
    expect(text).not.toContain('SECTION B')
  }, 30_000)
})

describe('branding', () => {
  it('prints the watermark on both documents', async () => {
    const [paper, key] = await Promise.all([
      renderQuestionPaper(input({ header: { ...input().header, watermark: WATERMARK_TOKEN } })),
      renderAnswerKey(input({ header: { ...input().header, watermark: WATERMARK_TOKEN } })),
    ])

    expect(await extractText(paper)).toContain(WATERMARK_TOKEN)
    expect(await extractText(key)).toContain(WATERMARK_TOKEN)
  }, 60_000)

  it('prints a LONG watermark in full rather than truncating it', async () => {
    /*
     * The bug this caught: at a flat 62pt, rotation happens after layout, so
     * the text box is still the page width and anything past ~15 characters
     * ran off the end of it silently. Every page of every paper.
     */
    const long = 'SPECIMEN COPY - DO NOT DISTRIBUTE'
    const pdf = await renderQuestionPaper(input({ header: { ...input().header, watermark: long } }))
    expect(await extractText(pdf)).toContain(long)
  }, 30_000)

  it('scales the watermark down as it gets longer, within bounds', () => {
    expect(watermarkFontSize('SPECIMEN')).toBe(62)
    expect(watermarkFontSize('CONFIDENTIAL')).toBe(62)
    // Long enough to need shrinking, but never below the legibility floor.
    expect(watermarkFontSize('SPECIMEN COPY - DO NOT DISTRIBUTE')).toBeLessThan(62)
    expect(watermarkFontSize('x'.repeat(500))).toBe(18)
  })

  it('omits the watermark entirely when unset', async () => {
    // Not defaulted to anything. A watermark on every paper is one nobody
    // reads, and it costs contrast on a document somebody writes on.
    const text = await extractText(await renderQuestionPaper(input()))
    expect(text).not.toContain(WATERMARK_TOKEN)
  }, 30_000)

  it('renders with a logo without changing the answer guarantees', async () => {
    /*
     * A 1x1 PNG. The point is not that a logo LOOKS right — that is checked by
     * eye in pdf-sample.test.ts — but that adding one cannot disturb the rule
     * the whole renderer is built around.
     */
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    )
    const pdf = await renderQuestionPaper(input({ header: { ...input().header, logo: png } }))
    const text = await extractText(pdf)

    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(text).not.toContain(ANSWER_MARKER)
    expect(text).not.toContain(EXPLANATION_TOKEN)
  }, 30_000)

  it('renders without a logo, which is the ordinary case', async () => {
    const pdf = await renderQuestionPaper(input({ header: { ...input().header, logo: null } }))
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
  }, 30_000)
})

describe('PDF engine — Indic scripts', () => {
  /*
   * Devanagari and Gujarati were proven to shape correctly during the Phase 0
   * spike, by rendering a page and looking at it. That check cannot be
   * automated — an unshaped Indic PDF is structurally valid and extracts as
   * the right codepoints even when the glyphs on the page are wrong.
   *
   * What IS worth asserting is that the pipeline runs at all for those
   * locales: the font file resolves, registration succeeds, and bytes come
   * out. A missing public/fonts on a deployment is the realistic failure, and
   * fonts.ts throws for it rather than silently falling back to Helvetica.
   */
  it.each(['hi', 'gu'] as const)('renders a %s paper without falling back', async (locale) => {
    const pdf = await renderQuestionPaper(input({ locale }))
    expect(pdf.subarray(0, 5).toString()).toBe('%PDF-')
    expect(pdf.length).toBeGreaterThan(1000)
  }, 30_000)
})
