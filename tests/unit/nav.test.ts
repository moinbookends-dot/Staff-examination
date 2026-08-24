import { describe, it, expect } from 'vitest'
import { mobileNavItems, visibleFootItems, visibleNavItems } from '@/lib/auth/nav'
import { DEFAULT_ROLE_PERMISSIONS } from '@/lib/auth/permissions'
import type { AppClaims } from '@/lib/auth/can'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Navigation: what each role sees, and what crosses to the client.
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
    // super_admin holds nothing explicitly: has_perm() short-circuits for it.
    perms: role === 'super_admin' ? [] : [...(DEFAULT_ROLE_PERMISSIONS[role] ?? [])],
  }
}

const SUPER_ADMIN = claimsFor('super_admin')
const ADMIN = claimsFor('admin')
const HR = claimsFor('hr')
const EMPLOYEE = claimsFor('employee')

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
    ...visibleNavItems(ADMIN),
    ...visibleFootItems(SUPER_ADMIN),
    ...mobileNavItems(ADMIN),
    ...visibleNavItems(ADMIN),
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

  it('forwards only serialisable fields', () => {
    /*
     * ┌───────────────────────────────────────────────────────────────────────┐
     * │ THIS ASSERTED AN EXACT KEY SET AND NOW ASSERTS THE ACTUAL DANGER.     │
     * │                                                                       │
     * │ It was `toEqual(['href','icon','labelKey'])`, which failed the moment  │
     * │ `activeFor` was added — a string array, entirely safe to serialise.    │
     * │ Widening the list to four would have restored green while weakening    │
     * │ nothing and testing nothing new.                                       │
     * │                                                                       │
     * │ What this file exists to catch is a FUNCTION crossing to a Client      │
     * │ Component — `guard: canManageExamSettings` shipped once and broke at   │
     * │ runtime only. So: keys must come from an allowlist, and every value    │
     * │ must survive a JSON round trip. A future `guard` fails on both counts. │
     * └───────────────────────────────────────────────────────────────────────┘
     */
    // shortLabelKey joined the list deliberately: a plain string, the mobile
    // tab bar's shorter label. Added here rather than loosened away, because
    // the point of the list is that a NEW key is a decision, not an accident.
    const ALLOWED = ['href', 'labelKey', 'shortLabelKey', 'icon', 'activeFor']

    for (const item of everything) {
      for (const key of Object.keys(item)) {
        expect(ALLOWED, `unexpected key "${key}" crossing to the client`).toContain(key)
      }
      // The real guard: a function survives Object.keys but not this.
      expect(() => structuredClone(item)).not.toThrow()
      expect(JSON.parse(JSON.stringify(item))).toEqual(item)
    }
  })
})

describe('Question Bank visibility', () => {
  /*
   * ┌───────────────────────────────────────────────────────────────────────────┐
   * │ THESE FOUR ASSERTIONS USED TO ENCODE A SPLIT THAT NO LONGER EXISTS.       │
   * │                                                                           │
   * │ Until migration 0071 the bank was shown to an Editor and HIDDEN FROM A    │
   * │ CHEF — the two roles each held half of what running an examination needs. │
   * │ 0071 renamed chef to admin and folded the Editor's bank permissions into  │
   * │ it, so "hidden from the operational role" is now the opposite of the      │
   * │ product. Renaming the fixtures alone would have left two assertions       │
   * │ contradicting each other on the same array.                               │
   * │                                                                           │
   * │ What still needs proving is that the bank is not visible to the roles     │
   * │ that genuinely must not have it, so that is what is asserted now.         │
   * └───────────────────────────────────────────────────────────────────────────┘
   */
  it('is shown to an Administrator', () => {
    expect(hrefs(visibleNavItems(ADMIN))).toContain('/questions')
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

  it('is hidden from HR and from an Employee', () => {
    // HR is read-only by design and an Employee sits exams. Neither holds
    // bank.read, and the bank is where every answer lives.
    expect(hrefs(visibleNavItems(HR))).not.toContain('/questions')
    expect(hrefs(visibleNavItems(EMPLOYEE))).not.toContain('/questions')
  })

  it('is in an Administrator’s mobile tab bar', () => {
    expect(hrefs(mobileNavItems(ADMIN))).toContain('/questions')
    expect(hrefs(mobileNavItems(HR))).not.toContain('/questions')
  })
})

describe('Settings visibility', () => {
  it('is shown to a Super Admin', () => {
    expect(hrefs(visibleFootItems(SUPER_ADMIN))).toContain('/settings')
  })

  /*
   * ╔═══════════════════════════════════════════════════════════════════════════╗
   * ║ /settings STOPPED BEING ADMIN-ONLY ON 11 AUG 2026 BECAUSE IT STOPPED     ║
   * ║ BEING SETTINGS.                                                          ║
   * ║                                                                           ║
   * ║ It was company configuration — paper sizes, languages, difficulty        ║
   * ║ labels, PDF header — behind settings.manage, and it rendered a read-only ║
   * ║ <dl>: no form, no save, and no exam_settings mutation anywhere in the    ║
   * ║ application. It is now the person's own profile.                         ║
   * ║                                                                           ║
   * ║ So "hidden from HR and from an Employee" became exactly backwards: they  ║
   * ║ are the people who most need it, and had no way to see or correct their  ║
   * ║ own name. What still has to hold is the approval gate, which the test    ║
   * ║ below covers.                                                            ║
   * ╚═══════════════════════════════════════════════════════════════════════════╝
   */
  it('is shown to every approved role', () => {
    for (const [label, claims] of [
      ['super admin', SUPER_ADMIN],
      ['admin', ADMIN],
      ['HR', HR],
      ['employee', EMPLOYEE],
    ] as const) {
      expect(hrefs(visibleFootItems(claims)), `${label} cannot reach their profile`).toContain(
        '/settings',
      )
    }
  })
})

describe('the approval gate still applies', () => {
  it('shows an unapproved user nothing but the always-visible items', () => {
    const pending: AppClaims = { ...ADMIN, approved: false }
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
    for (const role of ['super_admin', 'admin', 'hr', 'employee'] as const) {
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

  it('puts Live exams in a Chef’s bar, with Exam History reachable as a tab', () => {
    /*
     * Exam History stopped being a sidebar entry when Papers became one section
     * with tabs, so the old `visibleNavItems(ADMIN)` contains '/history' check
     * no longer describes the product. What still matters is that it is
     * REACHABLE — the Papers item covers it via activeFor, and the tab bar in
     * components/papers/papers-tabs.tsx links to it.
     */
    const tabs = hrefs(mobileNavItems(ADMIN))
    expect(tabs).toContain('/exams/live')
    expect(tabs).not.toContain('/history')

    const sidebar = visibleNavItems(ADMIN)
    const papers = sidebar.find((i) => i.href === '/papers/generate')
    expect(papers, 'a Chef has no Papers section at all').toBeDefined()
    expect(papers?.activeFor, 'Papers does not light up on /history').toContain('/history')
  })

  it('never hides a capped tab from the sidebar as well', () => {
    /*
     * The cap TRUNCATES, so a Super Admin — who holds everything — loses a tab
     * off the end of the bar. That is only acceptable because the sidebar is
     * complete: an item dropped from the bar must still be reachable, or the
     * cap would silently remove a screen from the product on small viewports.
     */
    for (const role of ['super_admin', 'admin', 'hr', 'employee'] as const) {
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
    const all = [...hrefs(visibleNavItems(SUPER_ADMIN)), ...hrefs(visibleNavItems(ADMIN))]
    // Paper-backed exams publish with verification_mode 'auto', so nothing
    // ever reaches the verify queue; analytics is separate work.
    for (const gone of ['/verify', '/reports']) {
      expect(all).not.toContain(gone)
    }
  })

  it('gives an Administrator the two screens that finish a sitting', () => {
    // '/exams' became '/exams/live' when the legacy exam list was deleted —
    // the section is the same, its landing route is not.
    const admin = hrefs(visibleNavItems(ADMIN))
    expect(admin).toContain('/exams/live')
    expect(admin).toContain('/evaluate')
  })

  it('gives an Administrator their own results but NOT the candidate list', () => {
    const admin = hrefs(visibleNavItems(ADMIN))
    // attempts.read_own — an admin can see results they were given.
    expect(admin).toContain('/results')
    // attempts.take — an admin does not hold it, and a "My exams" link would
    // lead to a list that is empty for them by construction.
    expect(admin).not.toContain('/my-exams')
  })

  it('gives an Employee exactly the three screens they can use', () => {
    const employee = claimsFor('employee')
    expect(hrefs(visibleNavItems(employee))).toEqual(['/dashboard', '/my-exams', '/results'])
  })

  /*
   * ╔═══════════════════════════════════════════════════════════════════════════╗
   * ║ THE ASSERTION 0071 EXISTS TO MAKE TRUE: ONE ROLE REACHES BOTH HALVES.    ║
   * ║                                                                           ║
   * ║ This replaces "shows an Editor no delivery screens — they author, they do ║
   * ║ not run exams", which was the exact separation the owner asked to remove. ║
   * ║ Before 0071 no single role could both fill the bank and run an exam from  ║
   * ║ it; asserting that the Administrator now spans authoring AND delivery is  ║
   * ║ the one-line statement of what the migration changed.                     ║
   * ╚═══════════════════════════════════════════════════════════════════════════╝
   */
  it('gives an Administrator the whole workflow — bank, papers, exams, marking', () => {
    const admin = hrefs(visibleNavItems(ADMIN))
    for (const needed of ['/questions', '/papers/generate', '/exams/live', '/evaluate']) {
      expect(admin, `an Administrator cannot reach ${needed}`).toContain(needed)
    }
  })

  it('still keeps HR read-only — no bank, no marking, no approvals', () => {
    const hr = hrefs(visibleNavItems(HR))
    for (const notTheirs of ['/questions', '/evaluate', '/approvals', '/papers/generate']) {
      expect(hr, `HR was offered ${notTheirs}`).not.toContain(notTheirs)
    }
  })
})

/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ AN ITEM ORed ON TWO PERMISSIONS CAN ONLY POINT AT ONE ROUTE.              ║
 * ║                                                                           ║
 * ║ THE BUG THIS BLOCK EXISTS FOR: the Papers item declares                   ║
 * ║ ['papers.generate', 'papers.read_history'] and isVisible() ORs them, so   ║
 * ║ HR — who holds only the second — was shown the item pointing at           ║
 * ║ /papers/generate. Confirmed against the running app: the HR dashboard     ║
 * ║ carried href="/en/papers/generate" and following it returned 500.         ║
 * ║                                                                           ║
 * ║ NOTHING IN THIS SUITE CAUGHT IT. Every assertion about the Papers href    ║
 * ║ was written against ADMIN, who holds both keys, so the suite passed with  ║
 * ║ the bug and would have passed with the fix — the worst kind of green.     ║
 * ║ hrefFor() now resolves the href per viewer; these are the assertions      ║
 * ║ that would have failed before it.                                        ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */
describe('the Papers item lands where the viewer can actually go', () => {
  const papersOf = (claims: AppClaims) =>
    visibleNavItems(claims).find((i) => i.activeFor?.includes('/history'))

  it('sends a generate-holder to the generator', () => {
    for (const [label, claims] of [
      ['super admin', SUPER_ADMIN],
      ['admin', ADMIN],
    ] as const) {
      expect(papersOf(claims)?.href, `${label} should land on the generator`).toBe(
        '/papers/generate',
      )
    }
  })

  it('sends a read-only holder to the history they can open', () => {
    // HR holds papers.read_history and not papers.generate.
    expect(papersOf(HR)?.href).toBe('/history')
  })

  it('shows the item to neither an Employee nor an unapproved account', () => {
    expect(papersOf(EMPLOYEE)).toBeUndefined()
    expect(papersOf({ ...ADMIN, approved: false })).toBeUndefined()
  })

  it('keeps BOTH prefixes lit whichever href the viewer got', () => {
    /*
     * useIsActive() is `matches(href) || any(matches(activeFor))`. Narrowing
     * activeFor to "the routes this viewer can open" would look tidy and would
     * put the sidebar back in the dark on a paper page — the exact bug
     * activeFor was added to fix. Asserted for both resolutions.
     */
    for (const claims of [ADMIN, HR]) {
      expect(papersOf(claims)?.activeFor).toContain('/papers')
      expect(papersOf(claims)?.activeFor).toContain('/history')
    }
  })

  it('resolves the href identically in the sidebar and the tab bar', () => {
    /*
     * The failure this guards is a half-applied fix: resolve in
     * visibleNavItems but not mobileNavItems and HR's bar carries
     * /papers/generate while their sidebar carries /history. "Never hides a
     * capped tab from the sidebar as well" catches it too; this says why.
     */
    for (const claims of [SUPER_ADMIN, ADMIN, HR]) {
      const sidebar = papersOf(claims)?.href
      const tab = mobileNavItems(claims).find((i) => i.activeFor?.includes('/history'))?.href
      expect(tab, 'the tab bar disagrees with the sidebar').toBe(sidebar)
    }
  })
})
