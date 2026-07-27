/**
 * Permission keys — the single source of truth.
 *
 * The `permissions` table is SEEDED FROM THIS LIST. Administrators compose
 * these keys into custom roles; they never invent new ones. A key in the
 * database but not here is unreachable; a key here but not in the database
 * grants nothing. CI asserts the two match (tests/unit/permissions.test.ts).
 *
 * Because `Permission` is a union of literals, a typo is a compile error
 * rather than a silently-denied request at runtime.
 *
 * Enforcement split (plan §5): RLS handles the coarse gate — role, org scope,
 * approval. These fine-grained keys are checked in the app by requirePermission()
 * at the top of every server action and route handler. Expressing
 * 'questions.import' as a Postgres policy would buy nothing and cost a join.
 */

export const PERMISSIONS = [
  // ── Question bank ──────────────────────────────────────────────────────────
  'questions.read',
  'questions.create',
  'questions.update',
  'questions.retire',
  'questions.import',
  'questions.translate',

  // ── Exams ──────────────────────────────────────────────────────────────────
  'exams.read',
  'exams.create',
  'exams.update',
  'exams.publish',
  'exams.assign',
  'exams.archive',

  // ── Attempts ───────────────────────────────────────────────────────────────
  'attempts.take',
  'attempts.read_own',
  'attempts.read_team',
  'attempts.read_all',
  'attempts.void',

  // ── Evaluation (the dual-chef workflow) ────────────────────────────────────
  'evaluation.evaluate',
  'evaluation.verify',
  'evaluation.return',
  'evaluation.publish',

  // ── Users ──────────────────────────────────────────────────────────────────
  'users.read_team',
  'users.read_all',
  'users.approve',
  'users.update',
  'users.assign_roles',

  // ── Organisation & platform ────────────────────────────────────────────────
  'roles.manage',
  'org.manage',
  'settings.manage',
  'audit.read',

  // ── Reports ────────────────────────────────────────────────────────────────
  'reports.read_own',
  'reports.read_team',
  'reports.read_all',
  'reports.export',

  // ── Learning centre (Phase 2) ──────────────────────────────────────────────
  'learning.read',
  'learning.manage',
] as const

export type Permission = (typeof PERMISSIONS)[number]

export const ROLE_KEYS = ['super_admin', 'chef', 'hr', 'employee'] as const
export type RoleKey = (typeof ROLE_KEYS)[number]

/**
 * Default role → permission mapping, from PRD §4.2's capability matrix.
 *
 * super_admin is intentionally NOT enumerated: `has_perm()` in migration 0004
 * short-circuits for it. Listing every key would mean each new permission had
 * to be remembered here, and forgetting one would lock the platform owner out
 * of a feature they own.
 *
 * Two deliberate deviations from the PRD matrix, both documented in the plan:
 *
 *  1. Super Admin CAN evaluate and verify. The PRD grants neither. That is a
 *     mistake — if the only chef is on leave mid-cycle, every submitted attempt
 *     is stuck forever with nobody able to unblock it. Covered by the implicit
 *     grant above; its use is conspicuous in the audit log.
 *
 *  2. HR is strictly read-only, as the PRD requires: reports and directory,
 *     no create, no evaluate, no approve.
 */
export const DEFAULT_ROLE_PERMISSIONS: Record<Exclude<RoleKey, 'super_admin'>, Permission[]> = {
  chef: [
    'questions.read', 'questions.create', 'questions.update', 'questions.retire',
    'questions.import', 'questions.translate',
    'exams.read', 'exams.create', 'exams.update', 'exams.publish', 'exams.assign', 'exams.archive',
    'attempts.read_team', 'attempts.read_own',
    'evaluation.evaluate', 'evaluation.verify', 'evaluation.return', 'evaluation.publish',
    'users.read_team', 'users.approve',
    'reports.read_team', 'reports.read_own', 'reports.export',
    'learning.read', 'learning.manage',
  ],

  hr: [
    'users.read_all',
    'attempts.read_all',
    'reports.read_all', 'reports.read_own', 'reports.export',
    'exams.read',
    'learning.read',
  ],

  employee: [
    'attempts.take', 'attempts.read_own',
    'reports.read_own',
    'learning.read',
  ],
}

/** Split 'questions.create' into its module and action halves. */
export function splitPermission(key: Permission): { module: string; action: string } {
  const [module, ...rest] = key.split('.')
  return { module, action: rest.join('.') }
}
