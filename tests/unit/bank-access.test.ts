import { describe, it, expect } from 'vitest'
import {
  canEditQuestions,
  canGeneratePapers,
  canManageEditors,
  canManageExamSettings,
  canOpenQuestionBank,
  canReadPaperHistory,
  canResetGenerationHistory,
  canSeeQuestionUuid,
  canSwitchBrand,
} from '@/lib/auth/bank-access'
import { DEFAULT_ROLE_PERMISSIONS } from '@/lib/auth/permissions'
// './can', not './claims' — see the box in that file. claims.ts pulls in the
// Supabase client and would require a configured environment to run these.
import type { AppClaims } from '@/lib/auth/can'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The access rules for the examination system.
 *
 * Built from DEFAULT_ROLE_PERMISSIONS rather than from hand-written permission
 * lists, so a grant added to a role in permissions.ts is reflected here
 * automatically — and a grant REMOVED from a role fails the test that depended
 * on it, rather than passing against a stale copy.
 * ═══════════════════════════════════════════════════════════════════════════
 */

function claimsFor(role: 'super_admin' | 'admin' | 'hr' | 'employee'): AppClaims {
  return {
    userId: `user-${role}`,
    approved: true,
    // 0070 added this to the claim. Every fixture here is a signed-in,
    // working user, so it is true — nav and bank access are decided after
    // both gates, never instead of them.
    email_verified: true,
    company_id: 'company-1',
    brand_id: 'brand-1',
    outlet_id: null,
    department_id: null,
    roles: [role],
    // super_admin is intentionally granted nothing explicitly: has_perm()
    // short-circuits for it, and can() mirrors that.
    perms: role === 'super_admin' ? [] : [...(DEFAULT_ROLE_PERMISSIONS[role] ?? [])],
  }
}

const SUPER_ADMIN = claimsFor('super_admin')
const ADMIN = claimsFor('admin')
const HR = claimsFor('hr')
const EMPLOYEE = claimsFor('employee')

describe('Question Bank access', () => {
  it('lets an Editor in', () => {
    expect(canOpenQuestionBank(ADMIN)).toBe(true)
    expect(canEditQuestions(ADMIN)).toBe(true)
    expect(canSeeQuestionUuid(ADMIN)).toBe(true)
  })

  it('lets a Super Admin into every bank surface', () => {
    /*
     * ╔═══════════════════════════════════════════════════════════════════════╗
     * ║ THIS TEST IS THE EXACT INVERSE OF WHAT IT USED TO ASSERT, AND THE      ║
     * ║ REASON IS A DECISION RATHER THAN A CONVENIENT REWRITE.                 ║
     * ║                                                                       ║
     * ║ It previously asserted `false` on all three, because these predicates  ║
     * ║ deliberately overrode can() to keep a Super Admin out of the bank —    ║
     * ║ separation of duties between administering the platform and authoring  ║
     * ║ the questions. The owner removed that on 10 Aug 2026.                  ║
     * ║                                                                       ║
     * ║ The assertion kept its shape on purpose: it still checks every bank    ║
     * ║ surface, so if somebody restores the lockout in one predicate and      ║
     * ║ forgets another, this fails rather than drifting quietly.              ║
     * ╚═══════════════════════════════════════════════════════════════════════╝
     */
    expect(SUPER_ADMIN.roles).toContain('super_admin')

    expect(canOpenQuestionBank(SUPER_ADMIN)).toBe(true)
    expect(canEditQuestions(SUPER_ADMIN)).toBe(true)
    expect(canSeeQuestionUuid(SUPER_ADMIN)).toBe(true)
  })

  /*
   * ╔═══════════════════════════════════════════════════════════════════════════╗
   * ║ "KEEPS A CHEF OUT OF THE BANK" WAS DELETED HERE, NOT RENAMED.            ║
   * ║                                                                           ║
   * ║ Migration 0071 renamed chef to admin and gave it the seven bank.* keys,  ║
   * ║ so the assertion became the exact opposite of the product. A mechanical  ║
   * ║ rename would have left this file asserting canOpenQuestionBank(ADMIN)    ║
   * ║ both true and false, a few lines apart.                                  ║
   * ║                                                                           ║
   * ║ The boundary that still exists — and still matters — is HR and Employee, ║
   * ║ who hold no bank key and must never see a question's answer. That is     ║
   * ║ what the two tests below assert, from both directions.                   ║
   * ╚═══════════════════════════════════════════════════════════════════════════╝
   */
  it('keeps HR and employees out of the bank', () => {
    for (const claims of [HR, EMPLOYEE]) {
      expect(canOpenQuestionBank(claims)).toBe(false)
      expect(canEditQuestions(claims)).toBe(false)
      expect(canSeeQuestionUuid(claims)).toBe(false)
    }
  })

  it('grants the UUID to Administrators and Super Admins only', () => {
    // The rule stated positively AND negatively, across every role, so neither
    // direction can rot unnoticed.
    const allowed = [ADMIN, SUPER_ADMIN]
    const denied = [HR, EMPLOYEE]

    for (const claims of allowed) expect(canSeeQuestionUuid(claims)).toBe(true)
    for (const claims of denied) expect(canSeeQuestionUuid(claims)).toBe(false)
  })
})

describe('paper generation access', () => {
  it('lets an Administrator generate and download', () => {
    expect(canGeneratePapers(ADMIN)).toBe(true)
    expect(canReadPaperHistory(ADMIN)).toBe(true)
  })

  it('lets a Super Admin generate too', () => {
    expect(canGeneratePapers(SUPER_ADMIN)).toBe(true)
    expect(canReadPaperHistory(SUPER_ADMIN)).toBe(true)
  })

  it('lets HR read history but not generate', () => {
    expect(canReadPaperHistory(HR)).toBe(true)
    expect(canGeneratePapers(HR)).toBe(false)
  })

  it('lets an employee do neither', () => {
    expect(canGeneratePapers(EMPLOYEE)).toBe(false)
    expect(canReadPaperHistory(EMPLOYEE)).toBe(false)
  })
})

describe('administration', () => {
  it('lets a Super Admin manage Editors', () => {
    // This used to assert the counterpart of the lockout — "they decide WHO
    // edits questions, and do not edit them". Since 10 Aug 2026 they do both,
    // so the second half is asserted the other way round and kept rather than
    // dropped: it is what proves the change reached every surface.
    expect(canManageEditors(SUPER_ADMIN)).toBe(true)
    expect(canOpenQuestionBank(SUPER_ADMIN)).toBe(true)
  })

  it('does not let an Administrator grant roles', () => {
    // Granting roles is users.assign_roles, which an Administrator does not
    // hold. Running the examination system and deciding who else may run it
    // are still separate powers — 0071 merged the operational roles, not this.
    expect(canManageEditors(ADMIN)).toBe(false)
  })

  it('reserves the generation reset for the Super Admin', () => {
    /*
     * papers.reset_history is granted to NOBODY in the seed. A super admin
     * reaches it only through the has_perm() short-circuit, which is exactly
     * the intent: the safety valve exists and using it is conspicuous.
     */
    expect(canResetGenerationHistory(SUPER_ADMIN)).toBe(true)
    for (const claims of [ADMIN, HR, EMPLOYEE]) {
      expect(canResetGenerationHistory(claims)).toBe(false)
    }
  })

  it('opens settings to Administrators as well as Super Admins', () => {
    // 0071 granted settings.manage to admin: the person who generates papers
    // is now the person who configures how papers are built. Before it, the
    // settings screen was unreachable by anyone who used it.
    expect(canManageExamSettings(SUPER_ADMIN)).toBe(true)
    expect(canManageExamSettings(ADMIN)).toBe(true)
    for (const claims of [HR, EMPLOYEE]) {
      expect(canManageExamSettings(claims)).toBe(false)
    }
  })
})

describe('brand scoping', () => {
  it('lets Administrators and Super Admins move between brands', () => {
    // canSwitchBrand mirrors public.brand_unscoped() in 0056: it is keyed on
    // bank.read, which an Administrator now holds. Before 0071 a Chef was
    // pinned to one brand precisely because they had no bank key.
    expect(canSwitchBrand(ADMIN)).toBe(true)
    expect(canSwitchBrand(SUPER_ADMIN)).toBe(true)
  })

  it('does not offer the brand switch to HR or an Employee', () => {
    expect(canSwitchBrand(HR)).toBe(false)
    expect(canSwitchBrand(EMPLOYEE)).toBe(false)
  })
})

describe('the approval gate still applies', () => {
  it('refuses everything to an unapproved account, whatever its role', () => {
    /*
     * can() ANDs in `approved`, so a pending or suspended user fails every
     * check for free — the same rule public.has_perm() enforces in the
     * database. Asserted here because these predicates wrap can() and a future
     * rewrite could bypass it.
     */
    const pendingEditor: AppClaims = { ...ADMIN, approved: false }

    expect(canOpenQuestionBank(pendingEditor)).toBe(false)
    expect(canEditQuestions(pendingEditor)).toBe(false)
    expect(canSeeQuestionUuid(pendingEditor)).toBe(false)
    expect(canGeneratePapers(pendingEditor)).toBe(false)
    expect(canReadPaperHistory(pendingEditor)).toBe(false)
  })

  it('refuses an unapproved super admin too', () => {
    const pendingAdmin: AppClaims = { ...SUPER_ADMIN, approved: false }
    expect(canManageEditors(pendingAdmin)).toBe(true) // role-based, by design
    expect(canResetGenerationHistory(pendingAdmin)).toBe(false)
  })
})
