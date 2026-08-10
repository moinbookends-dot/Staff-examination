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
 * ║ THE SUPER ADMIN LOCKOUT WAS REMOVED ON 10 AUG 2026, BY THE OWNER'S        ║
 * ║ EXPLICIT INSTRUCTION: "give all the access to super admin everything".    ║
 * ║                                                                           ║
 * ║ WHAT USED TO BE HERE, so nobody re-derives it from scratch: these three   ║
 * ║ predicates each began `if (isSuperAdmin(claims)) return false`, which     ║
 * ║ kept a Super Admin out of the bank screens even though has_perm() grants  ║
 * ║ them everything. It was a SEPARATION OF DUTIES rule — the person who      ║
 * ║ administers the platform does not also author the questions or read the   ║
 * ║ answer keys — and it lived here because the RBAC has no concept of a      ║
 * ║ denial to express it with.                                                ║
 * ║                                                                           ║
 * ║ WHAT REMOVING IT MEANS, stated plainly rather than buried: a Super Admin  ║
 * ║ can now read every question, every answer key and every translation, and  ║
 * ║ can create and edit questions. Question authorship is no longer separable ║
 * ║ from platform administration anywhere in the product.                     ║
 * ║                                                                           ║
 * ║ NO MIGRATION WAS NEEDED, and that is the tell that this was only ever an  ║
 * ║ application boundary. has_perm() has always short-circuited TRUE for      ║
 * ║ super_admin (0004), so every bank RLS policy already admitted them —      ║
 * ║ measured during the stabilization audit with a real Super Admin JWT:      ║
 * ║ SELECT bank_questions 200, INSERT 201, SELECT question_topics 200. The    ║
 * ║ screens were the only thing refusing.                                     ║
 * ║                                                                           ║
 * ║ To restore the separation, put the three guards back — nothing else       ║
 * ║ changed, and public.is_super_admin() still exists for the SQL half if a   ║
 * ║ real containment boundary is ever wanted instead.                         ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * May this caller open the Question Bank at all?
 *
 * Editors and Super Admins: yes. Chefs: no, and that one is structural rather
 * than a policy decision — a chef holds no bank.* key and no RLS policy on
 * bank_questions admits them, so the screen would be empty even if it were
 * offered.
 */
export function canOpenQuestionBank(claims: AppClaims): boolean {
  return can(claims, 'bank.read')
}

/** May this caller create or edit questions? */
export function canEditQuestions(claims: AppClaims): boolean {
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
