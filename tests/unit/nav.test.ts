import { describe, it, expect } from 'vitest'
import { mobileNavItems, visibleFootItems, visibleNavItems } from '@/lib/auth/nav'
import { DEFAULT_ROLE_PERMISSIONS } from '@/lib/auth/permissions'
import type { AppClaims } from '@/lib/auth/can'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Navigation: what each role sees, and what crosses to the client.
 * ═══════════════════════════════════════════════════════════════════════════
 */

function claimsFor(role: 'super_admin' | 'editor' | 'chef' | 'hr' | 'employee'): AppClaims {
  return {
    userId: `user-${role}`,
    approved: true,
    company_id: 'company-1',
    brand_id: 'brand-1',
    outlet_id: null,
    department_id: null,
    roles: [role],
    // super_admin holds nothing explicitly: has_perm() short-circuits for it.
    perms: role === 'super_admin' ? [] : [...(DEFAULT_ROLE_PERMISSIONS[role] ?? [])],
  }
}

const SUPER_ADMIN = claimsFor('super_admin')
const EDITOR = claimsFor('editor')
const CHEF = claimsFor('chef')

const hrefs = (items: { href: string }[]) => items.map((i) => i.href)

describe('serialisability across the Server → Client boundary', () => {
  /*
   * ╔═══════════════════════════════════════════════════════════════════════╗
   * ║ THE TEST THIS FILE EXISTS FOR.                                         ║
   * ║                                                                       ║
   * ║ These arrays are built in a Server Component and passed as props into  ║
   * ║ <SidebarNav> and <MobileTabBar>, which are Client Components. React    ║
   * ║ serialises everything that crosses, and a function cannot be           ║
   * ║ serialised:                                                            ║
   * ║                                                                       ║
   * ║   Functions cannot be passed directly to Client Components…            ║
   * ║   The offending value is: guard: function canManageExamSettings        ║
   * ║                                                                       ║
   * ║ That shipped. It typechecked, it linted, and `next build` succeeded —  ║
   * ║ the failure only appears when a signed-in page actually renders, which ║
   * ║ no automated check was exercising.                                     ║
   * ║                                                                       ║
   * ║ So the guarantee is asserted directly: nothing these functions return  ║
   * ║ may hold a value that is not JSON.                                     ║
   * ╚═══════════════════════════════════════════════════════════════════════╝
   */
  const everything = [
    ...visibleNavItems(EDITOR),
    ...visibleFootItems(SUPER_ADMIN),
    ...mobileNavItems(EDITOR),
    ...visibleNavItems(CHEF),
  ]

  it('returns no functions on any item', () => {
    for (const item of everything) {
      for (const [key, value] of Object.entries(item)) {
        expect(typeof value, `${item.href} carries a function at "${key}"`).not.toBe('function')
      }
    }
  })

  it('survives a JSON round trip unchanged', () => {
    // The blunt version of the same check: whatever React does to serialise a
    // prop, a value that JSON cannot represent will not arrive intact.
    expect(JSON.parse(JSON.stringify(everything))).toEqual(everything)
  })

  it('exposes only href, labelKey and icon', () => {
    // Guards against a future field being added to the config and forwarded.
    // toClientItem() copies three fields explicitly for this reason.
    for (const item of everything) {
      expect(Object.keys(item).sort()).toEqual(['href', 'icon', 'labelKey'])
    }
  })
})

describe('Question Bank visibility', () => {
  it('is shown to an Editor', () => {
    expect(hrefs(visibleNavItems(EDITOR))).toContain('/questions')
  })

  it('is HIDDEN from a Super Admin, whose permission check passes', () => {
    /*
     * The governance boundary, asserted at the nav layer as well as at
     * bank-access. can(SUPER_ADMIN, 'bank.read') is true — has_perm()
     * short-circuits — so the permission list alone would show this item.
     * canOpenQuestionBank is what removes it.
     */
    expect(hrefs(visibleNavItems(SUPER_ADMIN))).not.toContain('/questions')
  })

  it('is hidden from a Chef', () => {
    expect(hrefs(visibleNavItems(CHEF))).not.toContain('/questions')
  })

  it('is absent from a Chef’s mobile tab bar', () => {
    // The bar renders four tabs for a Chef and five for an Editor; it must not
    // assume a fixed count.
    expect(hrefs(mobileNavItems(CHEF))).not.toContain('/questions')
    expect(hrefs(mobileNavItems(EDITOR))).toContain('/questions')
  })
})

describe('Settings visibility', () => {
  it('is shown to a Super Admin', () => {
    expect(hrefs(visibleFootItems(SUPER_ADMIN))).toContain('/settings')
  })

  it('is hidden from an Editor and a Chef', () => {
    // Keyed on canManageExamSettings, which wraps settings.manage — neither
    // role holds it.
    expect(hrefs(visibleFootItems(EDITOR))).not.toContain('/settings')
    expect(hrefs(visibleFootItems(CHEF))).not.toContain('/settings')
  })
})

describe('the approval gate still applies', () => {
  it('shows an unapproved user nothing but the always-visible items', () => {
    const pending: AppClaims = { ...EDITOR, approved: false }
    // can() ANDs in `approved`, so every permission-gated item disappears.
    expect(hrefs(visibleNavItems(pending))).toEqual(['/dashboard'])
    expect(visibleFootItems(pending)).toEqual([])
  })
})

describe('removed legacy navigation stays removed', () => {
  it('offers no route from the deleted delivery stack', () => {
    const all = [
      ...hrefs(visibleNavItems(SUPER_ADMIN)),
      ...hrefs(visibleNavItems(EDITOR)),
      ...hrefs(visibleNavItems(CHEF)),
    ]
    for (const gone of ['/exams', '/evaluate', '/verify', '/results', '/reports', '/my-exams']) {
      expect(all).not.toContain(gone)
    }
  })
})
