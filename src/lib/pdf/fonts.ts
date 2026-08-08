import 'server-only'
import { Font } from '@react-pdf/renderer'
import { existsSync } from 'node:fs'
import path from 'node:path'
import type { BankLocale } from '@/lib/bank/vocabulary'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Font registration for the PDF engine.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ ONE FAMILY PER LANGUAGE, AND NEVER MIXING TWO IN ONE TEXT NODE.           ║
 * ║                                                                           ║
 * ║ @react-pdf/renderer has NO FONT FALLBACK. A character the active family   ║
 * ║ does not contain does not render as a blank box and does not raise — it   ║
 * ║ renders as whatever glyph happens to sit at that index in the font, which ║
 * ║ produces confident-looking nonsense.                                      ║
 * ║                                                                           ║
 * ║ This is not theoretical. The Phase 0 spike printed an English annotation  ║
 * ║ that happened to contain a few Gujarati characters, in the Latin family,  ║
 * ║ and it came out as:                                                       ║
 * ║                                                                           ║
 * ║     ¬¿,½he ɡmust sit LEFT of ¬§Á©#°ONE ligature.                          ║
 * ║                                                                           ║
 * ║ Nothing failed. Nothing warned. It simply printed.                        ║
 * ║                                                                           ║
 * ║ THE RULE THAT PREVENTS IT: pick the family from the document's locale and ║
 * ║ use it for EVERY text node on the page, including the English-looking     ║
 * ║ furniture — "Name:", "Total Marks:", the page number. Noto Devanagari and ║
 * ║ Noto Gujarati both carry full Latin and digits, so a Hindi paper set      ║
 * ║ entirely in NotoSansDevanagari renders its English labels correctly.      ║
 * ║ The reverse is not true, which is why the choice is made by locale and    ║
 * ║ never per element.                                                        ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ VARIABLE FONTS, AND WHY BOLD IS A SEPARATE REGISTRATION AND NOT A WEIGHT. │
 * │                                                                           │
 * │ Google ships these three families only as variable fonts. fontkit reads   │
 * │ them at their DEFAULT instance — Regular — and react-pdf has no way to    │
 * │ ask for a different axis position, so `fontWeight: 'bold'` on a variable  │
 * │ registration silently renders regular text.                               │
 * │                                                                           │
 * │ Rather than ship a paper whose headings are not actually bold and hope    │
 * │ nobody notices, emphasis is done with SIZE and COLOUR, which are exact.   │
 * │ If real bold is ever wanted, the fix is a static Bold TTF per family      │
 * │ registered under the same name with fontWeight: 700 — not a CSS property  │
 * │ that quietly does nothing.                                                │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */

const FONT_DIR = path.join(process.cwd(), 'public', 'fonts')

/** family name → file, one per script. */
const FONT_FILES = {
  NotoLatin: 'NotoSans-VF.ttf',
  NotoDeva: 'NotoSansDevanagari-VF.ttf',
  NotoGuj: 'NotoSansGujarati-VF.ttf',
} as const

export type FontFamily = keyof typeof FONT_FILES

/**
 * The family a document in this language must use for EVERY text node.
 *
 * Total, not partial: a locale added to BankLocale without an entry here is a
 * compile error rather than a paper that renders in the wrong script.
 */
const FAMILY_BY_LOCALE: Record<BankLocale, FontFamily> = {
  en: 'NotoLatin',
  hi: 'NotoDeva',
  gu: 'NotoGuj',
}

export function fontFamilyFor(locale: BankLocale): FontFamily {
  return FAMILY_BY_LOCALE[locale]
}

let registered = false

/**
 * Register all three families, once per process.
 *
 * Idempotent because react-pdf keeps a module-level registry and re-registering
 * the same name is wasted work on every render. Called by the render functions
 * rather than at import time, so importing the types does not touch the disk.
 */
export function ensureFontsRegistered(): void {
  if (registered) return

  for (const [family, file] of Object.entries(FONT_FILES)) {
    const src = path.join(FONT_DIR, file)

    /*
     * A missing font file must stop the render, loudly, here.
     *
     * react-pdf's failure mode for an unresolvable font is to fall back to
     * Helvetica — which has no Devanagari or Gujarati glyphs at all, so a
     * Hindi paper would render as the wrong-glyph nonsense described above
     * rather than as an error. A missing file is a deployment problem
     * (public/fonts not copied), and it has to look like one.
     */
    if (!existsSync(src)) {
      throw new Error(
        `PDF font missing: ${src}. public/fonts must ship with the deployment — ` +
          `without it, Hindi and Gujarati papers render as incorrect glyphs rather than failing.`,
      )
    }

    Font.register({ family, src })
  }

  /*
   * Hyphenation off.
   *
   * react-pdf hyphenates English by default, and its algorithm knows nothing
   * about Devanagari or Gujarati — where a break inside a conjunct produces a
   * cluster that is not a word in either language. Turning it off costs some
   * ragged right margins and removes a class of wrong output nobody would
   * think to check for.
   */
  Font.registerHyphenationCallback((word) => [word])

  registered = true
}
