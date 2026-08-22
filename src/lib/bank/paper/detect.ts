import { looksLikeAikoAnswerKey, looksLikeAikoHtml, parseAikoAnswerKey, parseAikoPaper } from './aiko-html'
import {
  looksLikePlainTextPaper,
  parsePlainTextAnswerKey,
  parsePlainTextPaper,
} from './plain-text'
import type { ParsedAnswerKey, ParsedPaper, PaperFormat, PaperRole } from './types'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Which parser, and which half of the pair.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ A FILE NOTHING RECOGNISES IS REFUSED BY NAME. IT IS NEVER GUESSED AT.     ║
 * ║                                                                           ║
 * ║ The tempting fallback — "try the text parser on anything" — would read a  ║
 * ║ PDF, a Word document or an unrelated HTML export as a handful of          ║
 * ║ nonsense questions and present them for import. The person would then be  ║
 * ║ deciding whether to accept a preview of garbage, which is a worse         ║
 * ║ position than being told the file is not one this importer reads.         ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * PDF IS ABSENT DELIBERATELY, and the brief made it conditional on exactly
 * this: nothing in this repository extracts text from a PDF. `pdf-to-img`
 * rasterises pages to bitmaps and `@react-pdf/renderer` only writes. Adding an
 * extractor would not settle it either — Devanagari in a PDF is stored as glyph
 * indices against an embedded subset font, and recovering conjuncts from that
 * is unreliable in a way that produces plausible-looking wrong Hindi. So .pdf
 * is refused with a sentence saying what to do instead.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export const ACCEPTED_EXTENSIONS = ['.html', '.htm', '.txt'] as const

/** Recognised, or a sentence saying why not. */
export type FormatVerdict =
  | { format: PaperFormat; role: PaperRole | null }
  | { fatal: string }

const PDF_REFUSED =
  'PDF is not supported. Nothing in this application extracts text from a PDF, and a Devanagari PDF in particular cannot be read back reliably — it would import Hindi that looks right and is not. Export the paper as HTML and import that.'

const DOCX_REFUSED =
  'Word documents are not supported. Save or export the paper as HTML and import that.'

/**
 * What kind of file is this, and is it a paper or a key?
 *
 * `role` is a SUGGESTION. The screen has separate slots for the paper and the
 * key, so the person has already said which is which; this only exists to warn
 * when the two look swapped, which is the mistake somebody actually makes when
 * both files sit in the same folder with similar names.
 */
export function detectFormat(fileName: string, text: string): FormatVerdict {
  const lower = fileName.toLowerCase()

  if (lower.endsWith('.pdf')) return { fatal: PDF_REFUSED }
  if (lower.endsWith('.docx') || lower.endsWith('.doc')) return { fatal: DOCX_REFUSED }

  if (!text.trim()) return { fatal: 'This file is empty.' }

  if (looksLikeAikoHtml(text)) {
    return { format: 'aiko-html', role: looksLikeAikoAnswerKey(text) ? 'answer-key' : 'paper' }
  }

  /*
   * HTML that is not the AIKO export. Reported as its own case rather than
   * falling through to the text parser, which would strip the tags into one
   * long line and find nothing — an unhelpful "no questions found" where the
   * real answer is "this is a different kind of HTML".
   */
  if (/<html[\s>]|<!doctype html/i.test(text)) {
    return {
      fatal:
        'This is an HTML file, but not in the format this importer reads. It has no question blocks carrying a data-id. Use the export produced by the question-generation process, or import a JSON file on the other tab.',
    }
  }

  if (looksLikePlainTextPaper(text)) return { format: 'plain-text', role: null }

  return {
    fatal:
      'This file is not one this importer reads. It accepts the HTML question-paper export, or plain text with one numbered question per line.',
  }
}

/** Parse a question paper in whichever recognised format it is in. */
export function parsePaper(format: PaperFormat, raw: string): ParsedPaper {
  return format === 'aiko-html' ? parseAikoPaper(raw) : parsePlainTextPaper(raw)
}

/** Parse an answer key in whichever recognised format it is in. */
export function parseAnswerKey(format: PaperFormat, raw: string): ParsedAnswerKey {
  return format === 'aiko-html' ? parseAikoAnswerKey(raw) : parsePlainTextAnswerKey(raw)
}
