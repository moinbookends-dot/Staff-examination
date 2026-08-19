/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Turning a fragment of presentation HTML back into the string it displayed.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ A MIS-ENCODED FILE IS REFUSED, NEVER REPAIRED.                            ║
 * ║                                                                           ║
 * ║ Read as Latin-1, "Jalapeño" arrives as "JalapeÃ±o" and every Devanagari   ║
 * ║ character arrives as mojibake outright. There is a well-known trick for   ║
 * ║ undoing that — re-encode to latin1, decode as utf-8 — and it must not be  ║
 * ║ used here.                                                                ║
 * ║                                                                           ║
 * ║ The reason is that the repair is INDISTINGUISHABLE from corrupting a file ║
 * ║ that was always correct: a legitimately Latin-1-looking sequence in a     ║
 * ║ correct UTF-8 document is silently rewritten into different characters,   ║
 * ║ and nobody who reads Hindi is looking at the diff. A thousand questions   ║
 * ║ would be imported subtly wrong, and the bank has no delete policy.        ║
 * ║                                                                           ║
 * ║ So: detect, refuse, and say what to do. Re-export as UTF-8.               ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Named and numeric entities the Aiko export actually emits, plus the handful
 * any HTML document may carry.
 *
 * Deliberately a fixed table rather than a DOM round trip. `innerHTML` on a
 * detached element would decode everything, but this module runs in vitest's
 * node environment as well as in a browser, and a parser whose behaviour
 * depends on which of the two it is in cannot be tested where it matters.
 */
const NAMED: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: '\u00a0',
  bull: '\u2022',
  ndash: '\u2013',
  mdash: '\u2014',
  hellip: '\u2026',
  rsquo: '\u2019',
  lsquo: '\u2018',
  rdquo: '\u201d',
  ldquo: '\u201c',
  times: '\u00d7',
  deg: '\u00b0',
}

/**
 * Decode entities, INCLUDING numeric ones.
 *
 * `&#x27;` is the interesting case: the generator escapes every apostrophe that
 * way, so a stem reading "एक शेफ के &#x27;गीला आधार&#x27; दोष" is one entity
 * away from correct and would otherwise be imported with the escape visible on
 * a printed exam paper.
 *
 * Runs BEFORE tag stripping is irrelevant either way — entities cannot contain
 * `<` — but it runs after, so a stray `&lt;div&gt;` in question text survives
 * as text rather than being stripped as markup. That ordering is the whole
 * reason these are two separate passes.
 */
export function decodeEntities(value: string): string {
  return value.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]*);/g, (whole, body: string) => {
    if (body.startsWith('#')) {
      const hex = body[1] === 'x' || body[1] === 'X'
      const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10)
      // A code point outside Unicode, or a lone surrogate, is left as written.
      // Producing U+FFFD here would trip the mojibake guard on a file whose
      // only fault is one bad entity.
      if (!Number.isFinite(code) || code < 1 || code > 0x10ffff) return whole
      if (code >= 0xd800 && code <= 0xdfff) return whole
      return String.fromCodePoint(code)
    }
    return NAMED[body] ?? NAMED[body.toLowerCase()] ?? whole
  })
}

/**
 * An HTML fragment as the plain string it rendered as.
 *
 * `<br>` becomes a space rather than vanishing — "line one<br>line two" must
 * not become "line oneline two". Everything else collapses to single spaces,
 * because the source is pretty-printed and every block is wrapped across lines
 * with leading indentation that is not part of the question.
 */
export function decodeHtml(fragment: string): string {
  return decodeEntities(
    fragment
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<\/(?:p|div|li|tr|h[1-6])\s*>/gi, ' ')
      .replace(/<[^>]*>/g, ''),
  )
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The characters that only appear when a UTF-8 file was read as something else.
 *
 * `Ã` is the giveaway for Latin-1: every two-byte UTF-8 sequence starting 0xC3
 * renders as "Ã" plus a second character. U+FFFD is the decoder having already
 * given up. `Â` catches the 0xC2 range, which is what turns a non-breaking
 * space into "Â ".
 *
 * A false positive is possible in principle — a document legitimately about
 * "Ã…ngstrÃ¶m" — and is accepted: refusing a correct file with a clear message
 * costs one re-export, where accepting a broken one costs a thousand corrupted
 * questions that nobody can delete.
 */
const MOJIBAKE = /[\uFFFD]|Ã[\u0080-\u00bf\u2013\u2014\u201a\u0192\u201e\u2026\u2020\u2021]|Â[\u00a0-\u00bf]/

/**
 * Refuse a file that was not read as UTF-8.
 *
 * Returns the reason, or null when the text is sound. Called once per file,
 * before any parsing, so the message names the file rather than a question.
 */
export function encodingFault(text: string): string | null {
  if (!MOJIBAKE.test(text)) return null
  return 'This file was not saved as UTF-8 — the non-English characters in it are already damaged. Re-export it as UTF-8 and try again. It is deliberately not repaired here, because repairing it cannot be told apart from corrupting a file that was correct.'
}

/**
 * A word of three or more Latin letters.
 *
 * The residual-English measure. A translated stem that still reads "A chef's
 * <dish> has the fault" is a generator problem, not a language problem, and the
 * Aug-17 Hard export was 90% English by this measure and was held back because
 * of it. Advisory only — the bar is a judgement, not a threshold.
 */
export function latinWords(value: string | null | undefined): string[] {
  return value?.match(/[A-Za-z]{3,}/g) ?? []
}
