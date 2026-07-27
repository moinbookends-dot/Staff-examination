/**
 * Exam Health — rendering helpers ONLY.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE CHECKS THEMSELVES LIVE IN public.exam_health() (migration 0014).      │
 * │ Nothing in this file re-implements one, and nothing should.               │
 * │                                                                           │
 * │ They are SQL because the validation has to run the REAL DRAW: two rules   │
 * │ can match the same question, and deduping means the second falls short    │
 * │ even though counting each rule independently says both are satisfiable.   │
 * │ A TypeScript re-implementation would count and would therefore pass an    │
 * │ exam that publish then refuses — the exact failure the check exists to    │
 * │ prevent.                                                                  │
 * │                                                                           │
 * │ publish_exam() calls the same function, so the screen a chef reads and    │
 * │ the gate that refuses them cannot disagree.                               │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

export type HealthSeverity = 'blocking' | 'advisory'

export interface HealthIssue {
  code: string
  severity: HealthSeverity
  section_id: string | null
  rule_id: string | null
  message: string
  detail: Record<string, unknown>
}

/**
 * Order for display: blocking first, then by code so the list is stable between
 * runs. A report that reshuffles itself on every refresh is one a chef stops
 * reading.
 */
export function sortIssues(issues: HealthIssue[]): HealthIssue[] {
  return [...issues].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'blocking' ? -1 : 1
    return a.code.localeCompare(b.code)
  })
}

export function blockingIssues(issues: HealthIssue[]): HealthIssue[] {
  return issues.filter((i) => i.severity === 'blocking')
}

export function canPublish(issues: HealthIssue[]): boolean {
  return blockingIssues(issues).length === 0
}

/**
 * What a chef should do about each code.
 *
 * The database message states the problem; this states the remedy. Keeping them
 * apart means a SQL message can stay factual and short while the UI can be
 * helpful, and neither has to be edited to change the other.
 */
export const ISSUE_REMEDY: Record<string, string> = {
  'structure.no_sections': 'Add a section, then a rule that says which questions to draw.',
  'structure.no_rules': 'Add at least one selection rule to this section.',
  'rule.short':
    'Widen the rule — a broader difficulty range, another category, or fewer questions — or write more questions for this area.',
  'paper.duplicate':
    'This should not be possible and indicates a bug in the draw. Report it rather than working around it.',
  'marks.zero': 'Give the questions marks, or set marks per question on the rule.',
  'media.missing':
    'Attach the image, audio, video or document this question refers to, or remove it from the bank.',
  'difficulty.narrow':
    'Consider widening the difficulty range so the exam can tell candidates apart.',
  'duration.mismatch': 'Adjust the time limit, or the number of questions.',
  'translation.missing':
    'Publish translations for these questions, or accept that this audience sits the exam in English.',
}

export function remedyFor(code: string): string | null {
  return ISSUE_REMEDY[code] ?? null
}
