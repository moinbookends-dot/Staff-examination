import { describe, it } from 'vitest'
import { writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { deflateSync, crc32 as zlibCrc32 } from 'node:zlib'
import { renderQuestionPaper, renderAnswerKey } from '@/lib/pdf'
import type { PaperDocumentInput, PaperQuestion } from '@/lib/pdf/types'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Writes real PDFs to scripts/.spike/samples/ so a human can look at them.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ SKIPPED BY DEFAULT. Run it deliberately:                                  │
 * │                                                                           │
 * │     PDF_SAMPLE=1 npx vitest run tests/unit/pdf-sample.test.ts             │
 * │     node scripts/pdf-to-png.mjs scripts/.spike/samples/paper-en.pdf       │
 * │                                                                           │
 * │ It asserts nothing. It exists because the automated suite cannot see the  │
 * │ things that actually go wrong with a printed page: a heading colliding    │
 * │ with a rule, options wrapping into two columns unevenly, a Devanagari     │
 * │ line whose matras sit on the wrong side. Text extraction reports all of   │
 * │ those as perfect.                                                         │
 * │                                                                           │
 * │ The Phase 0 spike proved shaping this way, and the ▶ → ¶ substitution was │
 * │ found by a text assertion only because it happened to change the          │
 * │ characters. A purely visual break would not have shown up at all.         │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * The content below is neutral scaffolding — no cookbook material and nothing
 * resembling a real exam question. It is shaped to stress the LAYOUT: a long
 * question that must wrap, long options that must not collide, and enough
 * questions to force a second page and exercise the fixed footer.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const OUT = resolve(__dirname, '../../scripts/.spike/samples')

/** Latin filler that wraps, with no meaning attached to it. */
const LONG = 'Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor'

function questions(locale: 'en' | 'hi' | 'gu'): PaperQuestion[] {
  // Script samples exist to exercise shaping and wrapping, not to say anything.
  const stem = { en: 'Question', hi: 'प्रश्न', gu: 'પ્રશ્ન' }[locale]
  const opt = { en: 'Option', hi: 'विकल्प', gu: 'વિકલ્પ' }[locale]
  const ans = { en: 'Answer', hi: 'उत्तर', gu: 'જવાબ' }[locale]

  const out: PaperQuestion[] = []
  for (let i = 1; i <= 16; i += 1) {
    out.push({
      questionNo: i,
      section: 'mcq',
      // Every third question is long enough to wrap onto a second line.
      text: i % 3 === 0 ? `${stem} ${i} — ${LONG}` : `${stem} ${i}`,
      options: {
        A: `${opt} A`,
        B: i % 4 === 0 ? `${opt} B — ${LONG.slice(0, 40)}` : `${opt} B`,
        C: `${opt} C`,
        D: `${opt} D`,
      },
      correctOption: (['A', 'B', 'C', 'D'] as const)[i % 4],
    })
  }
  for (let i = 17; i <= 20; i += 1) {
    out.push({
      questionNo: i,
      section: 'short_answer',
      text: `${stem} ${i}`,
      answerText: `${ans} ${i}`,
      explanation: `${ans} ${i} — ${LONG.slice(0, 60)}`,
    })
  }
  return out
}

/**
 * A solid-colour PNG, built here rather than pasted in as base64.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE FIRST VERSION WAS A HAND-TYPED BASE64 LITERAL AND IT WAS CORRUPT.     │
 * │                                                                           │
 * │ It failed as `invalid bit length repeat` thrown from zlib INSIDE the PDF  │
 * │ renderer, as an unhandled error that hung the run until the 120s timeout  │
 * │ — an error message with nothing in it pointing at the image.              │
 * │                                                                           │
 * │ Encoding it properly is forty lines and cannot be wrong. A test fixture   │
 * │ that has to be transcribed accurately by hand is a fixture that will      │
 * │ eventually be transcribed inaccurately.                                   │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlibCrc32(body))
    return Buffer.concat([length, body, crc])
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type 2 = truecolour RGB
  // 10, 11, 12 stay 0: deflate, adaptive filtering, no interlace.

  // Raw scanlines: one filter byte (0 = None) then width × RGB per row.
  const raw = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (1 + width * 3)
    raw[rowStart] = 0
    for (let x = 0; x < width; x += 1) {
      const p = rowStart + 1 + x * 3
      raw[p] = rgb[0]
      raw[p + 1] = rgb[1]
      raw[p + 2] = rgb[2]
    }
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** A wide dark block, so the logo slot is unmistakable in the rendered page. */
const SAMPLE_LOGO = solidPng(120, 32, [17, 28, 45])

function input(locale: 'en' | 'hi' | 'gu'): PaperDocumentInput {
  return {
    locale,
    header: {
      title: 'Bookends Hospitality',
      companyName: 'Bookends Hospitality',
      brandName: 'Sample Brand',
      paperNo: 42,
      difficultyLabel: { en: 'Medium', hi: 'मध्यम', gu: 'મધ્યમ' }[locale],
      totalMarks: 20,
      passingPercent: 60,
      footerText: null,
      logo: SAMPLE_LOGO,
      // Long enough to exercise watermarkFontSize()'s shrink path, which a
      // short word would not.
      watermark: 'SPECIMEN - DO NOT COPY',
    },
    questions: questions(locale),
  }
}

describe.skipIf(!process.env.PDF_SAMPLE)('PDF samples', () => {
  it('writes a paper and key for each language', async () => {
    mkdirSync(OUT, { recursive: true })

    for (const locale of ['en', 'hi', 'gu'] as const) {
      const [paper, key] = await Promise.all([
        renderQuestionPaper(input(locale)),
        renderAnswerKey(input(locale)),
      ])
      writeFileSync(resolve(OUT, `paper-${locale}.pdf`), paper)
      writeFileSync(resolve(OUT, `key-${locale}.pdf`), key)
      console.log(`  wrote paper-${locale}.pdf and key-${locale}.pdf`)
    }
  }, 120_000)
})
