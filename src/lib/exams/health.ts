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
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THIS MAP MUST COVER EVERY CODE THE DATABASE CAN EMIT.                     │
 * │                                                                           │
 * │ remedyFor returns null for an unknown code, and the UI renders the        │
 * │ problem with no advice under it. That is a silent gap: the screen looks   │
 * │ finished, and only somebody who has met that specific code knows          │
 * │ something is missing.                                                     │
 * │                                                                           │
 * │ Four codes were missing when M9 started — key.missing, added by 0022, and │
 * │ all three of 0035's translation advisories. Each had shipped without a    │
 * │ remedy for a milestone or more.                                           │
 * │                                                                           │
 * │ tests/unit/health-codes.test.ts now reads the migrations and fails if a   │
 * │ code exists in SQL with no entry here, so the next addition cannot repeat │
 * │ it.                                                                       │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * bank.* codes come from bank_recommendations() (0045), which returns exam
 * health's exact shape on purpose — one renderer, one remedy map.
 */
export const ISSUE_REMEDY: Record<string, string> = {
  // ── Structure and draw (0014, 0022) ────────────────────────────────────────
  'structure.no_sections': 'Add a section, then a rule that says which questions to draw.',
  'structure.no_rules': 'Add at least one selection rule to this section.',
  'rule.short':
    'Widen the rule — a broader difficulty range, another category, or fewer questions — or write more questions for this area.',
  'paper.duplicate':
    'This should not be possible and indicates a bug in the draw. Report it rather than working around it.',
  'marks.zero': 'Give the questions marks, or set marks per question on the rule.',
  'media.missing':
    'Attach the image, audio, video or document this question refers to, or remove it from the bank.',
  'key.missing':
    'Open the question and save it again. That captures an answer key against the current wording; until then nothing can grade it.',
  'difficulty.narrow':
    'Consider widening the difficulty range so the exam can tell candidates apart.',
  'duration.mismatch': 'Adjust the time limit, or the number of questions.',

  // ── Translation (0035) ─────────────────────────────────────────────────────
  'translation.missing':
    'Publish translations for these questions, or accept that this audience sits the exam in English.',
  'translation.stale':
    'Re-open the translation workbench for these questions: the English was reworded after the translation was published, so it describes text that no longer exists.',
  'translation.accepts_stale':
    'Re-publish this exam. It froze the question revisions at publish time, so accepted answers added since are not in the key a candidate is marked against.',
  'translation.section_title':
    'Nothing to do yet — section headings have no translation mechanism. Keep them short and use words that travel.',

  // ── Statistical quality (0046) ─────────────────────────────────────────────
  'quality.negative_discrimination':
    'Check the answer key first — a key naming the wrong option produces exactly this. If the key is right, the wording is probably misleading strong candidates.',
  'quality.misrated':
    'Change the difficulty rating to match how candidates actually perform, or re-read the question to see why it is harder or easier than intended.',
  'quality.non_discriminating':
    'Everyone answers this much the same way, so it adds length without adding information. Consider replacing it or sharpening the distractors.',
  'quality.bloom_narrow':
    'Add questions at other Bloom levels so the paper tests more than recall, or accept that this exam is deliberately narrow.',

  // ── The bank as a whole (0045) ─────────────────────────────────────────────
  'bank.thin': 'Write more questions before building exams — rules will fall short of what they ask for.',
  'bank.uncategorised':
    'Give these questions a category. Rules select by category, so an uncategorised question can never be drawn.',
  'bank.no_bloom':
    'Set a Bloom level on these questions so papers can be balanced for cognitive demand.',
  'bank.category_concentrated':
    'Write questions in other categories, or accept that this bank is deliberately about one subject.',
  'bank.difficulty_narrow':
    'Add easier and harder questions so a drawn paper can tell candidates apart.',
}

export function remedyFor(code: string): string | null {
  return ISSUE_REMEDY[code] ?? null
}
