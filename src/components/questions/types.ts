import type {
  AnswerKey,
  AnswerPayload,
  QuestionContent,
  QuestionContentDraft,
  ValidationIssue,
} from '@/lib/questions/schemas'

/**
 * The two component contracts every response format implements.
 *
 * Both are declared here rather than in the registry so an editor can import
 * its props without importing the registry that lists it — which would be a
 * cycle, and would pull all nine formats into every chunk.
 */

/** Content permissive enough to render mid-edit. See the note on the renderer. */
export type RenderableContent = QuestionContent | QuestionContentDraft

export interface FormatEditorProps {
  content: QuestionContentDraft
  answerKey: AnswerKey

  /**
   * ONE callback for both halves, deliberately.
   *
   * Content and key are co-designed: ticking "correct" beside option c is a key
   * edit made from a content control, and deleting option c must remove it from
   * the key in the same commit. Two separate callbacks make that two renders
   * with an inconsistent state in between — which is exactly how a key ends up
   * naming an option id that no longer exists. That parses cleanly against both
   * schemas and then marks every candidate wrong.
   */
  onChange: (next: { content: QuestionContentDraft; answerKey: AnswerKey }) => void

  disabled?: boolean
  /** From publishIssues(), so the editor can mark the offending field. */
  issues?: ValidationIssue[]
}

export interface FormatRendererProps {
  /**
   * Draft-typed on purpose: the editor previews as you type, so content is
   * routinely incomplete — two blank options, an empty item list. A renderer
   * that assumed the strict shape would crash on the first keystroke.
   * M4's exam delivery passes strict QuestionContent, which satisfies this.
   */
  content: RenderableContent

  answer: AnswerPayload
  /** Omitted in preview. Supplied by exam delivery in M4. */
  onAnswerChange?: (answer: AnswerPayload) => void
  readOnly?: boolean
}
