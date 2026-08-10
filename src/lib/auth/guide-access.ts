import type { AppClaims } from './can'
import { can } from './can'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Who may open the Guide, and who may add to it.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ TWO VOCABULARIES, ONE LIBRARY — AND THIS IS THE BRIDGE BETWEEN THEM.      ║
 * ║                                                                           ║
 * ║ The Guide is the cookbook library a question is written FROM, so in the   ║
 * ║ rebuilt product it is an EDITOR's reference material. Everything about    ║
 * ║ it was keyed on the legacy `questions.read` / `questions.import`, which   ║
 * ║ only a Chef holds — so an Editor got a 500 and a Chef got a library they  ║
 * ║ never write from. Exactly backwards.                                     ║
 * ║                                                                           ║
 * ║ Migration 0065 made all eight RLS policies accept EITHER vocabulary, and  ║
 * ║ these predicates are the application half of the same rule. Accepting     ║
 * ║ both rather than swapping means nothing is taken from a Chef today.       ║
 * ║                                                                           ║
 * ║ WHEN THE LEGACY DROP LANDS: delete the `questions.*` half of each line    ║
 * ║ here and the matching half in 0065's policies. Nothing else changes.      ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** May this caller open the document library and read its files? */
export function canOpenGuide(claims: AppClaims): boolean {
  return can(claims, 'bank.read') || can(claims, 'questions.read')
}

/** May this caller upload, edit or restore a document? */
export function canManageGuideDocuments(claims: AppClaims): boolean {
  return can(claims, 'bank.import') || can(claims, 'questions.import')
}

/**
 * The permission pair each predicate covers, for requireAnyPermission().
 *
 * Exported as constants rather than repeated at each call site: a guard that
 * lists one key and a policy that lists two is how a route starts refusing
 * somebody the database would have admitted.
 */
export const GUIDE_READ_PERMISSIONS = ['bank.read', 'questions.read'] as const
export const GUIDE_WRITE_PERMISSIONS = ['bank.import', 'questions.import'] as const
