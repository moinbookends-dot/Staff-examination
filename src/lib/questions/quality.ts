/**
 * Types and presentation helpers for M9's quality signals.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ NO THRESHOLD LIVES IN THIS FILE.                                          │
 * │                                                                           │
 * │ Every number that decides whether a question is weak — the sample floor,  │
 * │ the discrimination cutoff, the facility bands, the two-band misrating gap │
 * │ — is in SQL, in 0044. This file names the verdicts SQL produces and       │
 * │ decides what colour they are.                                             │
 * │                                                                           │
 * │ The temptation is to add `if (facility > 0.95) return 'too_easy'` here so │
 * │ the UI can be clever without a round trip. That is exactly how the bank,  │
 * │ the dashboard and exam_health would end up disagreeing about the same     │
 * │ question, which is the failure M9 is built to avoid.                      │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

/** Mirrors the CASE in question_quality (0044), worst first. */
export const QUALITY_VERDICTS = [
  'negative_discrimination',
  'misrated',
  'non_discriminating',
  'too_hard',
  'too_easy',
  'sound',
  'unproven',
] as const

export type QualityVerdict = (typeof QUALITY_VERDICTS)[number]

export interface QuestionQualityRow {
  question_id: string
  stem: string
  attempts_n: number
  facility: number | null
  discrimination: number | null
  author_difficulty: number | null
  observed_difficulty: number | null
  verdict: QualityVerdict
  flags: string[]
}

export interface DistractorRow {
  option_id: string
  option_text: string | null
  is_correct: boolean
  chosen_n: number
  chosen_share: number | null
  is_dead: boolean
  outdraws_key: boolean
}

export interface BankDistribution {
  dimension: 'bloom' | 'difficulty' | 'category' | 'type' | 'status'
  bucket: string
  is_missing: boolean | null
  n: number
}

/**
 * How loudly to render a verdict.
 *
 * `unproven` is deliberately the quietest thing on the screen. It is the most
 * common verdict on any young bank, and drawing it in a warning colour would
 * paint the whole dashboard amber on day one — after which nobody reads the
 * colours at all.
 */
export const VERDICT_TONE: Record<QualityVerdict, 'destructive' | 'warning' | 'success' | 'secondary'> = {
  // The key is probably wrong. Strong candidates are getting it wrong and weak
  // ones right, which is what a mis-keyed question looks like from the outside.
  negative_discrimination: 'destructive',
  misrated: 'warning',
  non_discriminating: 'warning',
  too_hard: 'warning',
  too_easy: 'warning',
  sound: 'success',
  unproven: 'secondary',
}

/** Verdicts that mean "somebody should look at this question". */
export function needsAttention(verdict: QualityVerdict): boolean {
  return verdict !== 'sound' && verdict !== 'unproven'
}

/**
 * Group a flat distribution into its dimensions, preserving order.
 *
 * bank_quality returns long format — (dimension, bucket, n) — so that adding a
 * seventh Bloom level needs no migration. The cost is one group-by, which is
 * this function.
 */
export function groupDistribution(
  rows: BankDistribution[],
): Map<BankDistribution['dimension'], BankDistribution[]> {
  const grouped = new Map<BankDistribution['dimension'], BankDistribution[]>()
  for (const row of rows) {
    const list = grouped.get(row.dimension)
    if (list) list.push(row)
    else grouped.set(row.dimension, [row])
  }
  // Difficulty is the one dimension with a natural order that is not
  // alphabetical: '10' must not sort before '2'. It cannot happen today (the
  // scale is 1–5) and would be invisible when it did.
  const difficulty = grouped.get('difficulty')
  if (difficulty) difficulty.sort((a, b) => Number(a.bucket) - Number(b.bucket))
  return grouped
}

/** Share of a dimension's total, as a percentage. Zero-safe. */
export function shareOf(row: BankDistribution, rows: BankDistribution[]): number {
  const total = rows.reduce((sum, r) => sum + r.n, 0)
  return total === 0 ? 0 : Math.round((row.n / total) * 100)
}
