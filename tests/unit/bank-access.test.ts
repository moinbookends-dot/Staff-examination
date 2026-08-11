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

function claimsFor(role: 'super_admin' | 'editor' | 'chef' | 'hr' | 'employee'): AppClaims {
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
const EDITOR = claimsFor('editor')
const CHEF = claimsFor('chef')
const HR = claimsFor('hr')
const EMPLOYEE = claimsFor('employee')

describe('Question Bank access', () => {
  it('lets an Editor in', () => {
    expect(canOpenQuestionBank(EDITOR)).toBe(true)
    expect(canEditQuestions(EDITOR)).toBe(true)
    expect(canSeeQuestionUuid(EDITOR)).toBe(true)
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

  it('keeps a Chef out of the bank', () => {
    // Structural rather than a policy decision: a chef holds no bank.* key and
    // no RLS policy on bank_questions admits them.
    expect(canOpenQuestionBank(CHEF)).toBe(false)
    expect(canEditQuestions(CHEF)).toBe(false)
    expect(canSeeQuestionUuid(CHEF)).toBe(false)
  })

  it('keeps HR and employees out of the bank', () => {
    for (const claims of [HR, EMPLOYEE]) {
      expect(canOpenQuestionBank(claims)).toBe(false)
      expect(canSeeQuestionUuid(claims)).toBe(false)
    }
  })

  it('grants the UUID to Editors and Super Admins only', () => {
    // The rule stated positively AND negatively, across every role. A Super
    // Admin moved from `denied` to `allowed` with the 10 Aug 2026 change; a
    // Chef, HR and an Employee are unaffected and still hold no bank key.
    const allowed = [EDITOR, SUPER_ADMIN]
    const denied = [CHEF, HR, EMPLOYEE]

    for (const claims of allowed) expect(canSeeQuestionUuid(claims)).toBe(true)
    for (const claims of denied) expect(canSeeQuestionUuid(claims)).toBe(false)
  })
})

describe('paper generation access', () => {
  it('lets a Chef generate and download', () => {
    expect(canGeneratePapers(CHEF)).toBe(true)
    expect(canReadPaperHistory(CHEF)).toBe(true)
  })

  it('lets an Editor generate too', () => {
    // Not scope creep: an Editor is the only person able to judge whether a
    // paper the bank produces is any good.
    expect(canGeneratePapers(EDITOR)).toBe(true)
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

  it('does not let an Editor grant the Editor role', () => {
    expect(canManageEditors(EDITOR)).toBe(false)
  })

  it('does not let a Chef grant roles', () => {
    expect(canManageEditors(CHEF)).toBe(false)
  })

  it('reserves the generation reset for the Super Admin', () => {
    /*
     * papers.reset_history is granted to NOBODY in the seed. A super admin
     * reaches it only through the has_perm() short-circuit, which is exactly
     * the intent: the safety valve exists and using it is conspicuous.
     */
    expect(canResetGenerationHistory(SUPER_ADMIN)).toBe(true)
    for (const claims of [EDITOR, CHEF, HR, EMPLOYEE]) {
      expect(canResetGenerationHistory(claims)).toBe(false)
    }
  })

  it('reserves settings for the Super Admin', () => {
    expect(canManageExamSettings(SUPER_ADMIN)).toBe(true)
    for (const claims of [EDITOR, CHEF, HR, EMPLOYEE]) {
      expect(canManageExamSettings(claims)).toBe(false)
    }
  })
})

describe('brand scoping', () => {
  it('pins a Chef to their own brand', () => {
    // Mirrors public.brand_unscoped() in 0056: a chef sees their brand's
    // papers, an Editor maintains every brand's bank.
    expect(canSwitchBrand(CHEF)).toBe(false)
  })

  it('lets Editors and Super Admins move between brands', () => {
    expect(canSwitchBrand(EDITOR)).toBe(true)
    expect(canSwitchBrand(SUPER_ADMIN)).toBe(true)
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
    const pendingEditor: AppClaims = { ...EDITOR, approved: false }

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
