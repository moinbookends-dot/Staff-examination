import { describe, expect, it } from 'vitest'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { renderQuestionPaper } from '@/lib/pdf'
import type { PaperDocumentInput } from '@/lib/pdf/types'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A WORD IS NEVER SPLIT ACROSS TWO LINES.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ WHAT THIS IS DEFENDING, AND WHY IT NEEDS A WHOLE PDF TO DO IT.            ║
 * ║                                                                           ║
 * ║ Hard Hindi papers printed "…अन्य गुणवत्ता ज" at the end of one line and   ║
 * ║ "ांच बिंदु…" at the start of the next — splitting जांच between its base   ║
 * ║ consonant and its own vowel sign. The result is not a hyphenated word; it ║
 * ║ is two fragments that are not words in Hindi, on an exam a candidate is   ║
 * ║ being marked on.                                                          ║
 * ║                                                                           ║
 * ║ The cause was NOT our data — the stored text is byte-identical to the     ║
 * ║ source export, with ordinary U+0020 spaces and no zero-width characters.  ║
 * ║ It was @react-pdf/textkit mapping string offsets onto shaped glyphs by    ║
 * ║ assuming the shaper returns them in logical order. It does not: fontkit   ║
 * ║ returns Devanagari in VISUAL order (a pre-base ि is emitted before the    ║
 * ║ consonant it belongs to) and its per-glyph codePoints do not partition    ║
 * ║ the string exactly — 153 reported for a 152-character stem. The mapping   ║
 * ║ drifted by one from that point on, so the line was cut one character      ║
 * ║ past the space the breaker had actually chosen.                           ║
 * ║                                                                           ║
 * ║ Fixed in patches/@react-pdf+textkit+6.3.0.patch. This test is the tripwire║
 * ║ on that patch: `npm ci` without patch-package, or a dependency bump that  ║
 * ║ drops it, fails HERE rather than on a printed exam.                       ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHY A COMBINING MARK AT THE START OF A LINE IS THE ASSERTION.             │
 * │                                                                           │
 * │ It is the one signature that cannot be produced by a legitimate break.    │
 * │ Dependent vowels, anusvara and virama attach to the consonant BEFORE      │
 * │ them, so no correctly-broken line can begin with one.                     │
 * │                                                                           │
 * │ U+093F (ि) and U+0ABF (િ) are excluded, and that exclusion is load-       │
 * │ bearing rather than a loosening: they are PRE-BASE vowels whose glyph is  │
 * │ legitimately drawn before its consonant, so pdf.js reports them first on  │
 * │ a line that in fact begins with that consonant. Including them flags      │
 * │ every line starting with नि, सि, वि … and buries the real defect.         │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** A dependent mark no correctly-broken line may begin with. See the box. */
const LEADING_COMBINING_MARK = /^[ऀ-ःऺ-ाी-ॏ॑-ॗॢॣઁ-ઃાી-્]/

/**
 * The exact stem that printed wrongly, from aiko-hard-0955.
 *
 * Kept verbatim rather than reduced to a minimal case: the defect only appears
 * once enough reordering has happened earlier in the paragraph to accumulate
 * the drift, and a shortened string does not reproduce it.
 */
const HINDI_STEM =
  "सर्विस के दौरान, शेफ का ड्रंकन नूडल्स 'अतिरिक्त तरल नहीं' गुणवत्ता जांच में विफल रहता है। शेफ को कौन सा अन्य गुणवत्ता जांच बिंदु भी सत्यापित करना चाहिए?"

/**
 * A Gujarati stem of comparable length.
 *
 * Stated plainly: GUJARATI NEVER REPRODUCED THIS DEFECT. Rendering all 1,030
 * translated Hard questions in both languages found 94 split words in Hindi and
 * none in Gujarati, before the patch or after it. This case therefore passes
 * with the patch reverted and guards nothing today — it is here so the
 * invariant is asserted for the other script we print, not because it is a
 * second regression test. The Hindi case above is the one that bites.
 */
const GUJARATI_STEM =
  'સર્વિસ દરમિયાન, શેફનો ડ્રંકન નૂડલ્સ ‘વધારાનું પ્રવાહી નહીં’ ગુણવત્તા ચકાસણીમાં નિષ્ફળ જાય છે. શેફે કયો અન્ય ગુણવત્તા ચકાસણી બિંદુ પણ ચકાસવો જોઈએ'

function paper(locale: 'hi' | 'gu', text: string): PaperDocumentInput {
  return {
    locale,
    header: {
      title: 'Bookends Hospitality',
      companyName: 'Bookends Hospitality',
      brandName: 'Aiko',
      paperNo: 1,
      difficultyLabel: 'X',
      totalMarks: 20,
      passingPercent: null,
      footerText: null,
      logo: null,
      watermark: null,
    },
    questions: [
      {
        questionNo: 1,
        section: 'mcq',
        text,
        options: { A: 'क', B: 'ख', C: 'ग', D: 'घ' },
      },
    ],
  }
}

/** Every rendered line on page 1, in visual order. */
async function renderedLines(buf: Buffer): Promise<string[]> {
  const doc = await getDocument({
    data: new Uint8Array(buf),
    useSystemFonts: false,
    standardFontDataUrl: 'node_modules/pdfjs-dist/standard_fonts/',
  }).promise

  const tc = await (await doc.getPage(1)).getTextContent()
  const byLine = new Map<number, string[]>()

  for (const item of tc.items as { str: string; transform: number[] }[]) {
    if (!item.str) continue
    // Group by baseline. Rounding is safe: react-pdf places every glyph on a
    // line at exactly the same y, and consecutive lines are ~15pt apart.
    const y = Math.round(item.transform[5])
    if (!byLine.has(y)) byLine.set(y, [])
    byLine.get(y)!.push(item.str)
  }

  return [...byLine.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([, parts]) => parts.join('').trim())
    .filter(Boolean)
}

describe('printed papers never split a word across lines', () => {
  it.each([
    ['Hindi', 'hi' as const, HINDI_STEM],
    ['Gujarati', 'gu' as const, GUJARATI_STEM],
  ])('%s', async (_label, locale, stem) => {
    const lines = await renderedLines(await renderQuestionPaper(paper(locale, stem)))

    // The stem is long enough to wrap; if it stopped wrapping, this test would
    // pass for the wrong reason and stop guarding anything.
    expect(lines.length).toBeGreaterThan(1)

    const offenders = lines.filter((line) => LEADING_COMBINING_MARK.test(line))
    expect(offenders).toEqual([])
  }, 120_000)
})
