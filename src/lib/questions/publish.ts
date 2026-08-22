import type { ZodSafeParseResult } from 'zod'
import {
  questionContentSchema,
  answerKeySchema,
  validateQuestion,
  type ValidationIssue,
} from './schemas'

/**
 * THE PUBLISH GATE — the other half of the draft/publish split.
 *
 * `questionContentDraftSchema` and the q_content_valid CHECK constraint are
 * deliberately permissive: they gate status='draft', so a half-written question
 * can be saved and returned to. Opening the editor covered in validation errors
 * before the chef has typed anything is how people learn to ignore validation.
 *
 * This is the strict gate, and it runs at exactly one moment: activation. Three
 * checks, in the only order that produces useful messages —
 *
 *   1. content parses strictly   (every option has text, arrays meet minimums)
 *   2. key parses strictly       (at least one correct answer, rubrics present)
 *   3. the two agree             (validateQuestion — the cross-shape checks)
 *
 * Step 3 is the one that cannot be skipped. A key naming an option id that no
 * longer exists parses perfectly against both schemas and then marks every
 * candidate wrong, with no error anywhere.
 *
 * PURE, AND THAT IS THE POINT. The editor calls it on every keystroke to show
 * what is blocking Publish; the server action calls it against what is actually
 * stored before flipping the status. Same code, so the button and the server can
 * never disagree — a Publish button that is enabled and then 403s is worse than
 * one that was never enabled.
 */
export function publishIssues(content: unknown, key: unknown): ValidationIssue[] {
  const parsedContent = questionContentSchema.safeParse(content)
  const parsedKey = answerKeySchema.safeParse(key)

  const issues: ValidationIssue[] = [
    ...zodIssues(parsedContent, 'content'),
    ...zodIssues(parsedKey, 'answerKey'),
  ]

  // Cross-shape validation needs two well-formed objects. Running it on a
  // failed parse would report "correct answer is not one of the options" when
  // the real problem is that there are no options yet — technically true, and
  // useless.
  if (parsedContent.success && parsedKey.success) {
    issues.push(...validateQuestion(parsedContent.data, parsedKey.data))
  }

  return issues
}

export function canPublish(content: unknown, key: unknown): boolean {
  return publishIssues(content, key).length === 0
}

/**
 * Zod issues in the same {path, message} shape validateQuestion returns, so the
 * editor renders one list rather than branching on where an issue came from.
 *
 * The `prefix` distinguishes a blank option ("content.choices.0.text") from a
 * missing correct answer ("answerKey.correct"), which otherwise both surface as
 * a bare field name and leave the chef hunting.
 */
function zodIssues(result: ZodSafeParseResult<unknown>, prefix: string): ValidationIssue[] {
  if (result.success) return []
  return result.error.issues.map((issue) => ({
    path: [prefix, ...issue.path.map(String)].join('.'),
    message: issue.message,
  }))
}
