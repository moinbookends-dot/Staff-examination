'use server'

import { requirePermission } from '@/lib/auth/guards'
import { createClient } from '@/lib/supabase/server'
import type { HealthIssue } from '@/lib/exams/health'
import type {
  BankDistribution,
  QuestionQualityRow,
  DistractorRow,
} from '@/lib/questions/quality'

/**
 * M9's reads. Thin wrappers, every one of them.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ NOTHING HERE COMPUTES A QUALITY SIGNAL.                                   │
 * │                                                                           │
 * │ facility, discrimination, misrated, dead distractors and the bank's       │
 * │ advisories are all decided in SQL — question_quality (0044),              │
 * │ question_distractors and bank_recommendations (0045). A TypeScript        │
 * │ threshold here would be a second opinion about what makes a question      │
 * │ weak, and exam_health would then disagree with the dashboard about the    │
 * │ same question.                                                            │
 * │                                                                           │
 * │ The permission below is the application's authorisation boundary, as       │
 * │ everywhere else. The DEFINER functions each carry their own check on top  │
 * │ (analytics_scope), so a caller who got past this line is still refused by │
 * │ the database if they should not be reading attempt data.                  │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

export async function getBankQuality(): Promise<BankDistribution[]> {
  await requirePermission('questions.read')

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('bank_quality')
  if (error) return []
  return (data ?? []) as unknown as BankDistribution[]
}

export async function getBankRecommendations(): Promise<HealthIssue[]> {
  await requirePermission('questions.read')

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('bank_recommendations')
  if (error) return []

  // bank_recommendations returns exam_health's shape minus section_id/rule_id,
  // which are meaningless for a bank-wide advisory. Filled in as null so one
  // component renders both — the reason 0045 chose that shape in the first place.
  return ((data ?? []) as unknown as Omit<HealthIssue, 'section_id' | 'rule_id'>[]).map(
    (row) => ({ ...row, section_id: null, rule_id: null }),
  )
}

/**
 * Statistical verdicts, worst first.
 *
 * Ordered here rather than in SQL because "worst" is a presentation decision:
 * the function returns the verdict and the sample size, and which of those a
 * chef wants at the top depends on whether they are auditing or browsing.
 */
export async function getQuestionQuality(categoryId?: string): Promise<QuestionQualityRow[]> {
  await requirePermission('questions.read')

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('question_quality', {
    p_question_id: undefined,
    p_category_id: categoryId,
  })
  if (error) return []

  const rank: Record<string, number> = {
    negative_discrimination: 0,
    misrated: 1,
    non_discriminating: 2,
    too_hard: 3,
    too_easy: 4,
    sound: 5,
    unproven: 6,
  }
  return ((data ?? []) as unknown as QuestionQualityRow[])
    .slice()
    .sort((a, b) => (rank[a.verdict] ?? 9) - (rank[b.verdict] ?? 9) || b.attempts_n - a.attempts_n)
}

/**
 * Which option each candidate actually picked.
 *
 * Returns [] for anything that is not multiple choice — the SQL function does
 * the same rather than raising, because this is asked for whatever row was
 * clicked and an essay question is an ordinary thing to click.
 */
export async function getQuestionDistractors(questionId: string): Promise<DistractorRow[]> {
  await requirePermission('questions.read')

  const supabase = await createClient()
  const { data, error } = await supabase.rpc('question_distractors', {
    p_question_id: questionId,
  })
  if (error) return []
  return (data ?? []) as unknown as DistractorRow[]
}
