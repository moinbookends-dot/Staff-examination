/*
 * From './can', never './claims'. claims.ts imports the Supabase server client
 * and therefore the environment, so importing it here would make these pure
 * predicates require a configured project to load — and untestable without
 * one. See the box at the top of ./can.
 */
import type { AppClaims } from './can'
import { can, isSuperAdmin } from './can'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Who may open the Question Bank, and who may see a question's UUID.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ "SUPER ADMIN CANNOT OPEN THE QUESTION EDITOR" IS NOT EXPRESSIBLE IN THIS  ║
 * ║ RBAC, AND THIS MODULE IS THE HONEST WORKAROUND.                           ║
 * ║                                                                           ║
 * ║ public.has_perm() short-circuits TRUE for super_admin (migration 0004),   ║
 * ║ and forty migrations of RLS policies are built on that. There is no deny  ║
 * ║ concept anywhere in the model: a permission is something you have or do   ║
 * ║ not, and a super admin has everything by construction. Adding a denial to ║
 * ║ has_perm() would change the meaning of every policy in the schema at      ║
 * ║ once, to serve one screen.                                                ║
 * ║                                                                           ║
 * ║ So the rule is enforced HERE, at the application boundary, by the three   ║
 * ║ predicates below — and every route guard and server action in the bank    ║
 * ║ calls them instead of can() directly.                                     ║
 * ║                                                                           ║
 * ║ WHAT THIS IS, STATED PLAINLY: a GOVERNANCE boundary, not a security one.  ║
 * ║                                                                           ║
 * ║ A super admin holds the platform. They can reach the same rows through    ║
 * ║ psql, through the service-role key, or by granting themselves the editor  ║
 * ║ role for ten seconds. Nothing here stops that and nothing could. What it  ║
 * ║ does is make the separation REAL IN THE PRODUCT: the screens are not      ║
 * ║ offered, the actions refuse, and any route around it is deliberate and    ║
 * ║ visible in the audit log rather than accidental.                          ║
 * ║                                                                           ║
 * ║ Do not describe it in the UI as though it were a security control, and    ║
 * ║ do not "fix" it by deleting these checks because has_perm() already       ║
 * ║ returns true. That return value IS the thing being overridden.            ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * May this caller open the Question Bank at all?
 *
 * Editors: yes. Super admins: no, by the rule above. Chefs: no, and that one
 * is structural rather than a policy decision — a chef holds no bank.* key and
 * no RLS policy on bank_questions admits them, so the screen would be empty
 * even if it were offered.
 */
/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE SUPER ADMIN LOCKOUT IS AN APPLICATION BOUNDARY. THE DATABASE DOES NOT ║
 * ║ ENFORCE IT, AND THAT IS A DECISION RATHER THAN AN OVERSIGHT.              ║
 * ║                                                                           ║
 * ║ has_perm() short-circuits on is_super_admin(), so every bank RLS policy   ║
 * ║ admits a Super Admin. Measured directly against the live database during  ║
 * ║ the stabilization audit, with a real Super Admin JWT:                     ║
 * ║                                                                           ║
 * ║     SELECT bank_questions  → 200                                          ║
 * ║     INSERT bank_questions  → 201                                          ║
 * ║     SELECT question_topics → 200                                          ║
 * ║                                                                           ║
 * ║ Every ROUTE refuses them — /questions/* via the subtree layout,           ║
 * ║ /api/bank/export via its own check, and bank_import_commit through this   ║
 * ║ predicate's callers. A Super Admin with a raw token and PostgREST does    ║
 * ║ not go through any of them.                                              ║
 * ║                                                                           ║
 * ║ WHY IT IS LEFT THIS WAY: a Super Admin holds user and role administration,║
 * ║ so they can grant themselves `editor` and import entirely legitimately.   ║
 * ║ The lockout separates DUTIES and makes the crossing conspicuous in the    ║
 * ║ audit log; it is not a containment boundary and must not be described as  ║
 * ║ one. Enforcing it in SQL (`and not public.is_super_admin()` across the    ║
 * ║ eight bank policies) would harden a door whose wall is already open, at   ║
 * ║ the cost of touching every Editor read and write path.                    ║
 * ║                                                                           ║
 * ║ If that trade is ever revisited, public.is_super_admin() already exists   ║
 * ║ and the change is mechanical.                                            ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */
export function canOpenQuestionBank(claims: AppClaims): boolean {
  if (isSuperAdmin(claims)) return false
  return can(claims, 'bank.read')
}

/** May this caller create or edit questions? */
export function canEditQuestions(claims: AppClaims): boolean {
  if (isSuperAdmin(claims)) return false
  return can(claims, 'bank.write')
}

/**
 * May this caller see a question's internal UUID?
 *
 * Separate from canOpenQuestionBank because the two answer different
 * questions and one is not implied by the other — bank.read_uuid is its own
 * grant precisely so that "who sees the id" is a decision somebody makes
 * rather than a side effect of being able to read the bank.
 *
 * The UI uses this to decide whether to render the column; the SERVER uses it
 * to decide whether to put the id in the payload at all. Only the second is
 * load-bearing: a field the server never sent cannot be recovered by anything
 * running in a browser.
 */
export function canSeeQuestionUuid(claims: AppClaims): boolean {
  if (isSuperAdmin(claims)) return false
  return can(claims, 'bank.read_uuid')
}

/** May this caller generate a paper? */
export function canGeneratePapers(claims: AppClaims): boolean {
  return can(claims, 'papers.generate')
}

/** May this caller see generated papers and download them? */
export function canReadPaperHistory(claims: AppClaims): boolean {
  return can(claims, 'papers.read_history')
}

/**
 * May this caller manage Editors — granting and revoking the role?
 *
 * The one bank-adjacent thing a super admin CAN do, and the counterpart to
 * everything above: they decide who edits questions, and do not edit them.
 */
export function canManageEditors(claims: AppClaims): boolean {
  return can(claims, 'users.assign_roles') || isSuperAdmin(claims)
}

/** May this caller change company settings — paper sizes, languages, labels? */
export function canManageExamSettings(claims: AppClaims): boolean {
  return can(claims, 'settings.manage')
}

/**
 * Reset the generation history, allowing an issued paper to be drawn again.
 *
 * Granted to nobody in the seed. A super admin reaches it through the
 * has_perm() short-circuit — which is the point: it is the safety valve for a
 * bank so thin it has locked up during rollout, and reaching for it should be
 * conspicuous rather than routine.
 */
export function canResetGenerationHistory(claims: AppClaims): boolean {
  return can(claims, 'papers.reset_history')
}

/**
 * Which brand this caller works in, and whether they may change it.
 *
 * Chefs are pinned to the brand on their profile; Editors and super admins
 * move between them, because an Editor maintains every brand's bank. Mirrors
 * public.brand_unscoped() in migration 0056 — the database enforces the same
 * rule on rows, and this decides whether to render a brand selector.
 */
export function canSwitchBrand(claims: AppClaims): boolean {
  return isSuperAdmin(claims) || can(claims, 'bank.read')
}
