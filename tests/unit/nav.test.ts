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

  it('is shown to a Super Admin', () => {
    /*
     * This asserted `not.toContain` until 10 Aug 2026, mirroring the
     * separation-of-duties lockout in bank-access.ts. The owner removed that
     * lockout; the nav follows it rather than keeping its own copy of the
     * rule, which is why only the expectation changed and nav.ts did not.
     */
    expect(hrefs(visibleNavItems(SUPER_ADMIN))).toContain('/questions')
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

/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THIS BLOCK USED TO ASSERT THAT SIX DELIVERY ROUTES STAYED OUT OF THE NAV. ║
 * ║ FOUR OF THEM CAME BACK, AND THE REASON IS A PRODUCT CHANGE, NOT A         ║
 * ║ CONVENIENT REINTERPRETATION OF A FAILING TEST.                            ║
 * ║                                                                           ║
 * ║ When those links were removed there was no online delivery: papers were   ║
 * ║ printed, and /my-exams, /results, /exams and /evaluate led to a stack     ║
 * ║ nothing fed. 0062 and 0063 made delivery real — a generated paper can be  ║
 * ║ published, assigned, sat on screen, and marked — so all four are now      ║
 * ║ steps in a workflow the product actually supports.                        ║
 * ║                                                                           ║
 * ║ /evaluate in particular is not optional. The 80/20 blueprint guarantees   ║
 * ║ short answers, so EVERY submitted attempt stops at `evaluating` and waits ║
 * ║ for a person. Without that link, papers could be published and sat and    ║
 * ║ the results would never come out.                                         ║
 * ║                                                                           ║
 * ║ /verify and /reports stay out, and are still asserted absent below.       ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */
describe('the mobile tab bar stays within its design budget', () => {
  /*
   * ┌───────────────────────────────────────────────────────────────────────────┐
   * │ FIVE IS A LAYOUT CONSTRAINT, NOT A PREFERENCE.                           │
   * │                                                                           │
   * │ MobileTabBar gives each item flex-1, so a sixth does not break the        │
   * │ layout — it silently shrinks every label until they truncate. At 390px    │
   * │ six items leave about 65px each, which is not enough for "Generate Exam". │
   * │                                                                           │
   * │ Adding Live exams DID push a Chef and an Editor to six, and nothing       │
   * │ failed: the bar just got tighter. This test is what noticed, and Exam     │
   * │ History gave up its slot as a result.                                     │
   * └───────────────────────────────────────────────────────────────────────────┘
   */
  it('offers no role more than five tabs', () => {
    for (const role of ['super_admin', 'editor', 'chef', 'hr', 'employee'] as const) {
      const tabs = mobileNavItems(claimsFor(role))
      expect(tabs.length, `${role} has ${tabs.length} tabs: ${hrefs(tabs).join(', ')}`)
        .toBeLessThanOrEqual(5)
    }
  })

  it('gives a candidate the two screens they actually use', () => {
    const tabs = hrefs(mobileNavItems(claimsFor('employee')))
    expect(tabs).toContain('/my-exams')
    expect(tabs).toContain('/results')
  })

  it('puts Live exams in a Chef’s bar and Exam History outside it', () => {
    const tabs = hrefs(mobileNavItems(CHEF))
    expect(tabs).toContain('/exams/live')
    // A desk task — reviewing and printing papers — so it lives in the sidebar.
    expect(tabs).not.toContain('/history')
    // …but it is still reachable.
    expect(hrefs(visibleNavItems(CHEF))).toContain('/history')
  })

  it('never hides a capped tab from the sidebar as well', () => {
    /*
     * The cap TRUNCATES, so a Super Admin — who holds everything — loses a tab
     * off the end of the bar. That is only acceptable because the sidebar is
     * complete: an item dropped from the bar must still be reachable, or the
     * cap would silently remove a screen from the product on small viewports.
     */
    for (const role of ['super_admin', 'editor', 'chef', 'hr', 'employee'] as const) {
      const claims = claimsFor(role)
      const sidebar = hrefs(visibleNavItems(claims))
      for (const tab of hrefs(mobileNavItems(claims))) {
        expect(sidebar, `${role}: ${tab} is in the bar but not the sidebar`).toContain(tab)
      }
    }
  })
})

describe('navigation for the delivery workflow', () => {
  it('still offers no route to the parts that remain unbuilt', () => {
    const all = [
      ...hrefs(visibleNavItems(SUPER_ADMIN)),
      ...hrefs(visibleNavItems(EDITOR)),
      ...hrefs(visibleNavItems(CHEF)),
    ]
    // Paper-backed exams publish with verification_mode 'single', so nothing
    // ever reaches the verify queue; analytics is separate work.
    for (const gone of ['/verify', '/reports']) {
      expect(all).not.toContain(gone)
    }
  })

  it('gives a Chef the two screens that finish a sitting', () => {
    const chef = hrefs(visibleNavItems(CHEF))
    expect(chef).toContain('/exams')
    expect(chef).toContain('/evaluate')
  })

  it('gives a Chef their own results but NOT the candidate list', () => {
    const chef = hrefs(visibleNavItems(CHEF))
    // attempts.read_own — a chef can see results they were given.
    expect(chef).toContain('/results')
    // attempts.take — a chef does not hold it, and a "My exams" link would
    // lead to a list that is empty for them by construction.
    expect(chef).not.toContain('/my-exams')
  })

  it('gives an Employee exactly the three screens they can use', () => {
    const employee = claimsFor('employee')
    expect(hrefs(visibleNavItems(employee))).toEqual(['/dashboard', '/my-exams', '/results'])
  })

  it('shows an Editor no delivery screens — they author, they do not run exams', () => {
    const editor = hrefs(visibleNavItems(EDITOR))
    for (const notTheirs of ['/exams', '/evaluate', '/my-exams']) {
      expect(editor).not.toContain(notTheirs)
    }
  })
})
