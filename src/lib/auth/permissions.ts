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
  // ── The examination question bank ──────────────────────────────────────────
  //
  // ┌─────────────────────────────────────────────────────────────────────────┐
  // │ WHY 'bank.*' AND NOT MORE 'questions.*' KEYS.                           │
  // │                                                                         │
  // │ These govern bank_questions — the two-type, three-level, trilingual      │
  // │ bank the examination system draws from. The 'questions.*' keys below     │
  // │ govern public.questions, the nine-format bank the old online delivery    │
  // │ system used, which is being removed.                                     │
  // │                                                                         │
  // │ A shared key would mean a chef's existing questions.read silently        │
  // │ becoming read access to the new bank the day it lands — and the new      │
  // │ bank's whole access story is that a chef CANNOT read it, because that    │
  // │ is what keeps question UUIDs away from them. Reusing the key would       │
  // │ hand every chef the thing the design exists to withhold.                 │
  // │                                                                         │
  // │ The 'questions.*' block dies with public.questions. This one stays.      │
  // └─────────────────────────────────────────────────────────────────────────┘
  'bank.read',
  'bank.write',
  'bank.archive',
  'bank.delete',
  'bank.import',
  'bank.export',
  // Separate from bank.read ON PURPOSE. "Only Editors see the UUID" has to be
  // a grant somebody makes, not a side effect of being able to read the bank.
  'bank.read_uuid',

  // ── Generated papers ───────────────────────────────────────────────────────
  'papers.generate',
  'papers.read_history',
  // Granted to NOBODY in the seed. Resetting lets a previously-issued paper be
  // generated again, so it exists only for a bank so thin it has locked up
  // during rollout — and super_admin reaches it through the has_perm()
  // short-circuit rather than through a grant anyone can hand out.
  'papers.reset_history',

  // ── Question bank (legacy — removed with public.questions) ─────────────────
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

export const ROLE_KEYS = ['super_admin', 'editor', 'chef', 'hr', 'employee'] as const
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
  /**
   * The examination system's authoring role. Owns the question bank and
   * nothing else — no user administration, no company settings.
   *
   * An Editor may generate a paper. That is not scope creep: they are the one
   * person who can tell whether a paper the bank produced is any good, and
   * withholding it would mean they could fill 6,000 questions without ever
   * seeing what comes out of them.
   */
  editor: [
    'bank.read', 'bank.write', 'bank.archive', 'bank.delete',
    'bank.import', 'bank.export', 'bank.read_uuid',
    'papers.generate', 'papers.read_history',
  ],

  chef: [
    // The new system: generate a paper, download it, look at the history.
    // These are ADDED beside the legacy keys rather than replacing them —
    // the old screens are still live and still gated on the old keys, and
    // revoking those before the replacements exist would lock a chef out of
    // a working application. The removal ships with the drop migration.
    'papers.generate', 'papers.read_history',

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
    'papers.read_history',
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
