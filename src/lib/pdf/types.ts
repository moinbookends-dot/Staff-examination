import type { BankLocale, OptionKey, QuestionType } from '@/lib/bank/vocabulary'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * What the PDF engine accepts.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE RENDERER OWNS NO DATA AND READS NO DATABASE.                          ║
 * ║                                                                           ║
 * ║ Everything it prints arrives in the object below. It performs no query,   ║
 * ║ holds no sample content, and has no fallback question to show when a      ║
 * ║ field is empty — an empty paper renders as an empty paper.                ║
 * ║                                                                           ║
 * ║ That is what makes it testable before the question bank exists, and it is ║
 * ║ also the boundary that keeps generated papers honest: the renderer cannot ║
 * ║ invent a question, because it has nowhere to get one from.                ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ ONE LANGUAGE PER DOCUMENT, NOT ONE DOCUMENT WITH THREE.                   │
 * │                                                                           │
 * │ A generated paper produces a separate PDF per language, and each carries  │
 * │ its own `locale`. Two reasons, and the second is not obvious:             │
 * │                                                                           │
 * │  1. A candidate sits one paper in one language. A trilingual page would   │
 * │     be three times as long and ask them to find their own language on it. │
 * │  2. FONTS. @react-pdf/renderer has no font fallback — a glyph missing     │
 * │     from the active family renders as an arbitrary WRONG glyph, not as a  │
 * │     blank box and not as an error. Proven during the Phase 0 spike, where │
 * │     a Latin-styled line containing Gujarati came out as readable-looking  │
 * │     nonsense. One locale per document means one font family per document, │
 * │     which is the only arrangement where that cannot happen.               │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * One question, already resolved into the language being printed.
 *
 * The renderer never sees a question id. It does not need one, and the UUID
 * rule says a chef must not receive one — so the type simply has no field for
 * it, and no future change to the renderer can leak what it was never given.
 */
export interface PaperQuestion {
  /** 1-based, printed beside the question and shared with the answer key. */
  questionNo: number
  section: QuestionType
  /** The question text, in this document's language. */
  text: string

  /**
   * Present for `mcq`, absent for `short_answer`. All four or none — 0054's
   * shape constraint guarantees that upstream, so the renderer treats a
   * partial set as a caller error rather than trying to lay out three options.
   */
  options?: Record<OptionKey, string>

  /**
   * ANSWER KEY ONLY. renderQuestionPaper() ignores all three of these even
   * when they are populated, so a caller that passes the full question set to
   * the wrong function cannot print the answers onto the candidate's paper.
   *
   * That is deliberate belt-and-braces: the alternative is two nearly
   * identical input types and a call site that picks the wrong one.
   */
  correctOption?: OptionKey
  answerText?: string

  /**
   * Why the answer is right, in this document's language.
   *
   * The person marking a paper is often not the person who wrote the question,
   * and a rationale is what lets them handle a near-miss answer consistently
   * rather than by instinct. Optional per question and per language — a bank
   * may be explained in English and not yet in Gujarati.
   */
  explanation?: string
}

/** Everything printed above the first question. */
export interface PaperHeader {
  /** Falls back to the company name when exam_settings.pdf_header is unset. */
  title: string
  companyName: string
  brandName: string

  /** The handle people quote. Question uuids are hidden; this is not. */
  paperNo: number

  /**
   * The company's label for the level, already resolved — the renderer never
   * sees the enum value and so cannot accidentally print "medium" in lower
   * case at a candidate.
   */
  difficultyLabel: string

  totalMarks: number

  /** Omitted from the page entirely when null, never printed as "0%". */
  passingPercent: number | null

  /** exam_settings.pdf_footer, falling back to the company name. */
  footerText: string | null

  /**
   * The company logo, as a data URI or raw image bytes.
   *
   * ┌───────────────────────────────────────────────────────────────────────┐
   * │ THE RENDERER DOES NOT FETCH IT.                                       │
   * │                                                                       │
   * │ A URL here would make PDF generation depend on a network call that    │
   * │ can be slow, can fail, and would silently produce a logo-less paper   │
   * │ when it did. The caller reads the bytes — from Storage, from disk —    │
   * │ and passes them, so a missing logo is a decision made somewhere a      │
   * │ person can see it rather than a timeout inside a renderer.            │
   * │                                                                       │
   * │ PNG or JPEG. Null means no logo, and the header simply centres         │
   * │ without one.                                                          │
   * └───────────────────────────────────────────────────────────────────────┘
   */
  logo?: Buffer | string | null

  /**
   * Diagonal text behind the questions — "CONFIDENTIAL", "SPECIMEN", a brand
   * name.
   *
   * Deliberately not defaulted to anything. A watermark on every paper is a
   * watermark nobody reads, and it costs contrast on a document somebody has
   * to write on.
   */
  watermark?: string | null
}

export interface PaperDocumentInput {
  locale: BankLocale
  header: PaperHeader
  /**
   * In printed order. The renderer does NOT sort: ordering is the generator's
   * decision (MCQ section shuffled, then short answers), it is recorded in
   * exam_paper_questions.question_no, and a renderer that re-sorted could make
   * the paper disagree with its own stored history.
   */
  questions: PaperQuestion[]
}

/**
 * Which document to produce from one input.
 *
 * The same PaperDocumentInput drives both, so a key can never describe a
 * different paper than the paper it belongs to — the failure that would
 * otherwise be possible if the two were rendered from separately-fetched data.
 */
export type PaperVariant = 'paper' | 'key'
