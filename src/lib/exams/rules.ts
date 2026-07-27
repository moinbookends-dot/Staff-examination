import { z } from 'zod'
import { dbId } from '@/lib/db/id'
import { questionTypeSchema } from '@/lib/questions/schemas'

/**
 * The exam contract at the application boundary.
 *
 * A selection rule is a saved question-bank filter, which is why the difficulty
 * and category shapes here mirror `questionFiltersSchema`
 * (src/lib/questions/filters.ts). They are not shared outright because the two
 * differ in one meaningful way: a bank filter narrows a list a chef is reading
 * and every field is optional, while a rule must state how many questions it
 * wants and is meaningless without that.
 *
 * Everything below is validated again by the database — CHECK constraints on
 * exam_rules, and exam_health() before publish. This layer exists to produce a
 * readable message before a chef meets a constraint violation.
 */

export const PAPER_MODES = ['fixed', 'per_attempt'] as const
export const paperModeSchema = z.enum(PAPER_MODES)
export type PaperMode = z.infer<typeof paperModeSchema>

export const EXAM_KINDS = [
  'official', 'practice', 'quiz', 'monthly', 'annual', 'practical',
] as const
export const examKindSchema = z.enum(EXAM_KINDS)
export type ExamKind = z.infer<typeof examKindSchema>

export const EXAM_STATUSES = [
  'draft', 'scheduled', 'active', 'completed', 'archived', 'cancelled',
] as const
export type ExamStatus = (typeof EXAM_STATUSES)[number]

/**
 * Which kinds freeze one paper and which draw per attempt.
 *
 * This is the DEFAULT only. `exams.paper_mode` is a column precisely so a chef
 * can override it — a practice exam set to `fixed` when two cohorts need
 * comparing is a legitimate thing to want. Read the column, never this map,
 * anywhere a decision actually depends on the mode.
 */
export const DEFAULT_PAPER_MODE: Record<ExamKind, PaperMode> = {
  official: 'fixed',
  monthly: 'fixed',
  annual: 'fixed',
  practical: 'fixed',
  practice: 'per_attempt',
  quiz: 'per_attempt',
}

/** Low-stakes kinds must not pollute difficulty calibration in M7. */
export const DEFAULT_COUNTS_TOWARDS_ANALYTICS: Record<ExamKind, boolean> = {
  official: true,
  monthly: true,
  annual: true,
  practical: true,
  practice: false,
  quiz: false,
}

export const examRuleSchema = z
  .object({
    id: dbId().optional(),
    categoryId: dbId().nullable().default(null),
    includeSubcategories: z.boolean().default(true),
    tagIds: z.array(dbId()).default([]),
    questionTypes: z.array(questionTypeSchema).nullable().default(null),
    difficultyMin: z.number().int().min(1).max(5).default(1),
    difficultyMax: z.number().int().min(1).max(5).default(5),
    questionCount: z.number().int().min(1).max(200),
    marksPerQuestion: z.number().positive().max(9999).nullable().default(null),
  })
  .refine((r) => r.difficultyMax >= r.difficultyMin, {
    path: ['difficultyMax'],
    message: 'The difficulty range runs backwards.',
  })

export type ExamRuleInput = z.input<typeof examRuleSchema>

export const examSectionSchema = z.object({
  id: dbId().optional(),
  title: z.string().trim().min(1, 'Give the section a title.').max(200),
  description: z.string().trim().max(2000).nullable().default(null),
  instructions: z.string().trim().max(4000).nullable().default(null),
  // Reserved: M4's delivery timer enforces it. Accepted now so a chef who sets
  // it does not lose the value when M4 lands.
  durationMinutes: z.number().int().min(1).max(600).nullable().default(null),
  rules: z.array(examRuleSchema).default([]),
})

export const examSchema = z.object({
  id: dbId().nullable().default(null),
  title: z.string().trim().min(3, 'Give the exam a title.').max(200),
  description: z.string().trim().max(4000).nullable().default(null),
  instructions: z.string().trim().max(8000).nullable().default(null),
  kind: examKindSchema.default('official'),
  paperMode: paperModeSchema.optional(),
  brandId: dbId().nullable().default(null),

  durationMinutes: z.number().int().min(1).max(600).default(30),
  opensAt: z.string().datetime().nullable().default(null),
  closesAt: z.string().datetime().nullable().default(null),
  timezone: z.string().min(1).max(60).default('Asia/Kolkata'),

  maxAttempts: z.number().int().min(1).max(10).default(1),
  passMarkPercent: z.number().min(0).max(100).default(60),
  shuffleQuestions: z.boolean().default(true),
  shuffleOptions: z.boolean().default(true),
  allowBacktrack: z.boolean().default(true),
  negativeMarkingEnabled: z.boolean().default(false),
  verificationMode: z.enum(['auto', 'single', 'dual']).default('dual'),
})

export type ExamInput = z.input<typeof examSchema>

export const assignmentSchema = z
  .object({
    targetKind: z.enum(['outlet', 'department', 'brand', 'role']),
    targetId: dbId().nullable().default(null),
    // A role KEY, not a uuid — has_role() reads keys straight from the JWT, so
    // a uuid would force the visibility policy to join user_roles.
    targetRole: z.string().trim().min(1).max(60).nullable().default(null),
  })
  .refine(
    (a) =>
      a.targetKind === 'role'
        ? a.targetRole !== null && a.targetId === null
        : a.targetId !== null && a.targetRole === null,
    { message: 'A role target needs a role key; every other target needs an id.' },
  )

export type AssignmentInput = z.input<typeof assignmentSchema>
