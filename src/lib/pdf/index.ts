import 'server-only'
import { renderToBuffer, type DocumentProps } from '@react-pdf/renderer'
import { createElement, type ReactElement } from 'react'
import { ensureFontsRegistered } from './fonts'
import { PaperDocument } from './paper'
import type { PaperDocumentInput, PaperVariant } from './types'

export type { PaperDocumentInput, PaperHeader, PaperQuestion, PaperVariant } from './types'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The PDF engine's entire public surface.
 *
 * Two functions, one input type, no data access. Give it a resolved paper and
 * it returns bytes; it queries nothing and holds no content of its own.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHY TWO FUNCTIONS RATHER THAN ONE WITH A FLAG.                            │
 * │                                                                           │
 * │ `renderPaper(input, 'key')` and `renderPaper(input, 'paper')` differ by   │
 * │ one string, and the difference between them is whether the answers are    │
 * │ printed. A wrong argument at a call site is a candidate sitting an exam   │
 * │ with the answer key stapled to it, and nothing about the call would look  │
 * │ wrong in review.                                                          │
 * │                                                                           │
 * │ Two named functions make that mistake unspellable. The variant is still   │
 * │ a parameter one level down, where the two callers below are the only      │
 * │ things that pass it.                                                      │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */

async function render(input: PaperDocumentInput, variant: PaperVariant): Promise<Buffer> {
  ensureFontsRegistered()

  /*
   * createElement rather than JSX, so this file stays .ts.
   *
   * The document itself is .tsx and reads as markup, which is where that
   * matters. Here it would only force the module that every server action
   * imports to be compiled as a React file.
   *
   * The cast is unavoidable and narrow. renderToBuffer is typed to accept
   * ReactElement<DocumentProps> — an element of <Document> itself — whereas
   * PaperDocument is a component that RETURNS one, so its props are its own
   * and share nothing with DocumentProps. Wrapping the call site in <Document>
   * instead would move the Page and every style out of paper.tsx for no gain.
   * PaperDocument's own props stay fully typed either side of this line.
   */
  const element = createElement(PaperDocument, { input, variant }) as unknown as ReactElement<
    DocumentProps
  >

  return renderToBuffer(element)
}

/**
 * The candidate's paper. Never prints an answer, whatever the input contains.
 *
 * The guarantee is in paper.tsx: correctOption and answerText are read in one
 * place, behind `isKey`. Passing the fully-populated question set here — which
 * is the normal thing to do, since both documents come from one fetch — is
 * safe by construction rather than by the caller remembering to strip them.
 */
export function renderQuestionPaper(input: PaperDocumentInput): Promise<Buffer> {
  return render(input, 'paper')
}

/** The marker's copy: every question repeated in full with its answer marked. */
export function renderAnswerKey(input: PaperDocumentInput): Promise<Buffer> {
  return render(input, 'key')
}
