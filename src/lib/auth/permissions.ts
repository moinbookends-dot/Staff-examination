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

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * FOUR ROLES. `editor` AND `chef` WERE ONE ROLE ALL ALONG.
 *
 * Migration 0071 renamed `chef` to `admin` and deleted `editor`, folding the
 * question-bank permissions into `admin`. The reason is in that file, and it
 * is worth repeating here because this list is what a reader checks first:
 * neither old role could run an examination on its own. A Chef could publish,
 * mark and release but could not open the bank the paper came from; an Editor
 * owned the bank and could generate a paper but could not publish or mark it.
 *
 * Removing a key from this union is a compile error at every site that named
 * it, which is the point — a role that no longer exists should not be
 * something the type system will let you ask about.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export const ROLE_KEYS = ['super_admin', 'admin', 'hr', 'employee'] as const
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
   * The one operational role: everything needed to run an examination
   * end to end.
   *
   * This is the former `chef` list plus the eight keys that used to belong to
   * `editor` — the seven `bank.*` keys and `settings.manage`. Migration 0071
   * makes the same grant in the database; `tests/unit/permissions.test.ts`
   * asserts the two agree, so a key added here and forgotten there fails CI
   * rather than producing a UI that offers something the database refuses.
   *
   * `bank.read_uuid` is in the list on purpose. It exists so that seeing a
   * question's UUID is a deliberate grant rather than a side effect of reading
   * the bank — and whoever edits a generated paper needs the id to say which
   * question they are replacing.
   *
   * `papers.reset_history` is still granted to NOBODY. Resetting the epoch
   * lets an already-issued paper be generated a second time; super_admin
   * reaches it through the has_perm() short-circuit, where it is conspicuous
   * in the audit log.
   */
  admin: [
    'bank.read', 'bank.write', 'bank.archive', 'bank.delete',
    'bank.import', 'bank.export', 'bank.read_uuid',

    'papers.generate', 'papers.read_history',

    // The legacy public.questions keys. Still here because the old authoring
    // screens are still gated on them; they go with the drop migration.
    'questions.read', 'questions.create', 'questions.update', 'questions.retire',
    'questions.import', 'questions.translate',

    'exams.read', 'exams.create', 'exams.update', 'exams.publish', 'exams.assign', 'exams.archive',
    'attempts.read_team', 'attempts.read_own',
    'evaluation.evaluate', 'evaluation.verify', 'evaluation.return', 'evaluation.publish',
    'users.read_team', 'users.approve',
    'reports.read_team', 'reports.read_own', 'reports.export',
    'settings.manage',
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
