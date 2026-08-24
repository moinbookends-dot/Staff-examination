import type { Permission } from './permissions'
import type { AppClaims } from './can'
import { can } from './can'
import { canGeneratePapers, canOpenQuestionBank } from './bank-access'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Navigation, matching the Stitch layout.
 *
 * Nav is derived from the SAME predicates the server actions and RLS policies
 * use, so a link can never appear for something the user cannot actually do.
 * Hand-maintaining a parallel "which roles see which menu" mapping is how UIs
 * drift into showing buttons that 403.
 *
 * Hiding a link is presentation, not security — every destination re-checks
 * via requirePermission() or the bank-access predicates.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * Exactly the icons NAV_ITEMS uses, and no more.
 *
 * This union held seven names nothing referenced — `guide` and `exams` for
 * sections that were deleted, plus `history`, `editors`, `topics`, `import`
 * and `profile` for items that were folded into others. ICONS in app-nav.tsx
 * is a `Record<NavIcon, LucideIcon>`, so every dead name obliged that file to
 * keep importing a lucide component for a link that could never render, and
 * the union was the only thing making those imports look necessary.
 *
 * Keeping it minimal means tsc reports the mismatch the moment the two drift.
 */
export type NavIcon =
  | 'dashboard'
  | 'bank'
  | 'generate'
  | 'liveExams'
  | 'evaluate'
  | 'myExams'
  | 'results'
  | 'approvals'
  | 'settings'

/**
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ TWO TYPES, AND THE SPLIT IS LOAD-BEARING RATHER THAN TIDINESS.            ║
 * ║                                                                           ║
 * ║ NavItemConfig is the SERVER-SIDE configuration. It holds predicates —     ║
 * ║ `guard` is a function — and it must never cross into a Client Component.  ║
 * ║                                                                           ║
 * ║ NavItem is what a client receives: href, labelKey, icon. Strings only.    ║
 * ║                                                                           ║
 * ║ This existed as ONE type and it was a runtime bug that typechecked and    ║
 * ║ built cleanly:                                                            ║
 * ║                                                                           ║
 * ║   Functions cannot be passed directly to Client Components…               ║
 * ║   The offending value is: guard: function canManageExamSettings           ║
 * ║                                                                           ║
 * ║ The layout is a Server Component and <SidebarNav> is a Client Component,  ║
 * ║ so every prop crossing between them is serialised. A function cannot be,  ║
 * ║ and nothing catches it until the page is actually rendered.               ║
 * ║                                                                           ║
 * ║ THE FIX IS NOT TO MARK THE PREDICATE 'use server'. canOpenQuestionBank    ║
 * ║ and canManageExamSettings are authorisation predicates, not Server        ║
 * ║ Actions; exposing them as callable endpoints to satisfy a serialiser      ║
 * ║ would turn a pure function into a remote procedure for no reason.         ║
 * ║                                                                           ║
 * ║ Instead the guards are EVALUATED ON THE SERVER, inside visibleNavItems()  ║
 * ║ and its siblings, and the result is stripped to the serialisable shape.   ║
 * ║ Every permission decision happens exactly where it did before.            ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 */

/** What a Client Component receives. Serialisable — no functions, ever. */
export interface NavItem {
  href: string
  /** Key under the `nav` namespace in messages/*.json. */
  labelKey: string
  /**
   * A shorter label, for the mobile tab bar only.
   *
   * Five tabs across a 390px phone give each one about 78px. "Question
   * Bank" does not fit and wraps to two lines, which drops its label below
   * every other tab and makes the bar look broken. Only the items that
   * need one set this; the sidebar always uses the full label.
   */
  shortLabelKey?: string
  icon: NavIcon
  /**
   * Extra path prefixes that should keep this item lit.
   *
   * ┌───────────────────────────────────────────────────────────────────────┐
   * │ NEEDED BECAUSE A SECTION'S TABS DO NOT ALWAYS SHARE ITS PREFIX.       │
   * │                                                                       │
   * │ useIsActive() matches on prefix, which is enough for Question Bank —  │
   * │ /questions/topics and /questions/import both start with /questions.   │
   * │ Papers does not have that luxury: its tabs are /papers/generate and   │
   * │ /history, and without this the sidebar would go dark the moment       │
   * │ somebody opened a paper, telling them they were nowhere.              │
   * │                                                                       │
   * │ Strings only — this crosses to a Client Component.                    │
   * └───────────────────────────────────────────────────────────────────────┘
   */
  activeFor?: string[]
}

/** The server-side configuration. Holds predicates and never leaves the server. */
interface NavItemConfig extends NavItem {
  /** Any one of these grants visibility. Empty means always visible. */
  permissions: Permission[]
  /**
   * ┌───────────────────────────────────────────────────────────────────────┐
   * │ AN EXTRA PREDICATE, ANDed WITH THE PERMISSIONS ABOVE.                 │
   * │                                                                       │
   * │ This existed to express a DENIAL the permission model cannot state:   │
   * │ a Super Admin passed can(claims, 'bank.read') and was nevertheless    │
   * │ locked out of the question bank. That lockout was removed on 10 Aug   │
   * │ 2026, so no item currently needs the escape hatch for that reason.    │
   * │                                                                       │
   * │ It is kept because the mechanism is still the right one: the guard is │
   * │ the SAME function the route and the server actions call, so the nav   │
   * │ cannot drift from the page. If a denial is ever needed again, it goes │
   * │ here and is enforced in all three places at once.                     │
   * └───────────────────────────────────────────────────────────────────────┘
   */
  guard?: (claims: AppClaims) => boolean
  /**
   * ╔═══════════════════════════════════════════════════════════════════════════╗
   * ║ WHERE THE ITEM LANDS, WHEN THAT DEPENDS ON WHAT THE READER MAY DO.        ║
   * ║                                                                           ║
   * ║ `permissions` is ORed — any one of them shows the item — and that is      ║
   * ║ right for a SECTION that several capabilities can enter. It is wrong for  ║
   * ║ the HREF, which can only point at one route.                              ║
   * ║                                                                           ║
   * ║ Papers is the case that proved it. It declares                            ║
   * ║ ['papers.generate', 'papers.read_history'] and points at                  ║
   * ║ /papers/generate. HR holds the SECOND key only, so the item rendered for  ║
   * ║ them and the link 500'd — verified against the running app, not inferred: ║
   * ║ the HR dashboard contained href="/en/papers/generate" and following it    ║
   * ║ returned 500.                                                             ║
   * ║                                                                           ║
   * ║ That contradicted this module's opening promise — "a link can never       ║
   * ║ appear for something the user cannot actually do". Hiding the item        ║
   * ║ instead would have been the other wrong answer: HR is entitled to paper   ║
   * ║ history and would have lost their only route to it.                       ║
   * ║                                                                           ║
   * ║ Evaluated on the server beside `guard`, so nothing but a string crosses   ║
   * ║ to the client.                                                            ║
   * ╚═══════════════════════════════════════════════════════════════════════════╝
   */
  hrefFor?: (claims: AppClaims) => string
  /** Shown in the mobile tab bar. The bar holds five at most. */
  mobile?: boolean
}

/**
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ A NAV ITEM IS A PROMISE ABOUT A ROUTE, AND THE ROUTE HAS TO KEEP IT       │
 * │ FIRST.                                                                    │
 * │                                                                           │
 * │ /learning and /admin sat in this list for two milestones with no page     │
 * │ behind either, so anybody holding those permissions saw a link that 404d. │
 * │ Nothing goes in here until its route returns 200.                         │
 * │                                                                           │
 * │ Entries are added as each screen lands. The Stitch sidebar order is       │
 * │ Dashboard, Question Bank, Generate, Exam History, Editor Management, with │
 * │ Settings pinned to the foot — SIDEBAR_FOOT below.                         │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
/**
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ EIGHT ITEMS, DOWN FROM THIRTEEN — AND THE MISSING FIVE ARE NOT GONE.      │
 * │                                                                           │
 * │ Topics and Import moved inside Question Bank; Exam History moved inside    │
 * │ Papers. Both are TABS on the section they belong to, using the pattern     │
 * │ this codebase already prefers — real links with aria-current, not client   │
 * │ state — so every screen keeps its own URL and stays bookmarkable.          │
 * │                                                                           │
 * │ /exams and /guide are genuinely gone: the first was a second, older exam   │
 * │ product built on the legacy questions table, and the second a document     │
 * │ library nothing referenced.                                               │
 * │                                                                           │
 * │ A NAV ITEM IS STILL A PROMISE ABOUT A ROUTE. /learning and /admin sat here │
 * │ for two milestones with no page behind either; nothing goes in this list   │
 * │ until its route returns 200.                                              │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
const NAV_ITEMS: NavItemConfig[] = [
  {
    href: '/dashboard',
    labelKey: 'dashboard',
    icon: 'dashboard',
    permissions: [],
    mobile: true,
  },
  {
    href: '/questions',
    labelKey: 'bank',
    shortLabelKey: 'bankShort',
    icon: 'bank',
    permissions: ['bank.read'],
    // The Super Admin lockout was removed on 10 Aug 2026; the guard stays
    // because it is still the one place that rule would live if restored.
    guard: canOpenQuestionBank,
    mobile: true,
    /*
     * Topics and Import are tabs inside this section now. They already matched
     * by prefix — useIsActive() lights /questions while on either child — so
     * they need no entry of their own here, only in the tab bar rendered by
     * src/app/[locale]/(app)/questions/layout.tsx.
     */
  },
  {
    href: '/papers/generate',
    labelKey: 'papers',
    icon: 'generate',
    permissions: ['papers.generate', 'papers.read_history'],
    /*
     * ╔═══════════════════════════════════════════════════════════════════════╗
     * ║ THE ITEM IS ORed ON TWO PERMISSIONS AND CAN ONLY POINT AT ONE ROUTE.  ║
     * ║                                                                       ║
     * ║ HR holds papers.read_history and NOT papers.generate, so isVisible()  ║
     * ║ showed them this item and the href 500'd. Confirmed against the       ║
     * ║ running app: the HR dashboard carried href="/en/papers/generate" and  ║
     * ║ following it returned 500.                                            ║
     * ║                                                                       ║
     * ║ Hiding the item instead would have been the other wrong answer — HR   ║
     * ║ is entitled to paper history, and SectionTabs renders nothing below   ║
     * ║ two tabs, so this sidebar entry is their ONLY route into /history.    ║
     * ║                                                                       ║
     * ║ canGeneratePapers is the same predicate PapersTabs already uses to    ║
     * ║ choose between these two routes (components/papers/papers-tabs.tsx),  ║
     * ║ so the sidebar and the section tabs cannot disagree about where a     ║
     * ║ given person's Papers section begins.                                 ║
     * ╚═══════════════════════════════════════════════════════════════════════╝
     */
    hrefFor: (claims) => (canGeneratePapers(claims) ? '/papers/generate' : '/history'),
    mobile: true,
    /*
     * /history does NOT share a prefix with /papers/generate, so without this
     * the Papers item would go dark the moment somebody opened a paper — the
     * sidebar would say they were nowhere.
     *
     * BOTH prefixes are kept for BOTH hrefs. A generate-holder needs '/history'
     * to stay lit on a paper page; a read-only holder needs '/papers' for the
     * same reason in reverse. Narrowing it per viewer would reintroduce the
     * dark-sidebar bug for one of them.
     */
    activeFor: ['/papers', '/history'],
  },
  {
    href: '/exams/live',
    labelKey: 'liveExams',
    icon: 'liveExams',
    permissions: ['exams.read'],
    mobile: true,
    // Upcoming and Closed are tabs on the section itself (ExamSection).
    activeFor: ['/exams'],
  },
  {
    href: '/evaluate',
    labelKey: 'evaluate',
    icon: 'evaluate',
    permissions: ['evaluation.evaluate'],
  },
  {
    href: '/my-exams',
    labelKey: 'myExams',
    icon: 'myExams',
    permissions: ['attempts.take'],
    mobile: true,
  },
  {
    href: '/results',
    labelKey: 'results',
    icon: 'results',
    permissions: ['attempts.read_own'],
    mobile: true,
  },
  {
    href: '/approvals',
    labelKey: 'approvals',
    icon: 'approvals',
    permissions: ['users.approve'],
  },
]

/**
 * Pinned to the bottom of the sidebar, per the Stitch design.
 *
 * A separate list rather than a `footer: true` flag, because the two are
 * rendered by different elements in the shell and a flag would mean every
 * consumer filtering the same array twice.
 */
const SIDEBAR_FOOT: NavItemConfig[] = [
  {
    href: '/settings',
    labelKey: 'settings',
    icon: 'settings',
    /*
     * ┌───────────────────────────────────────────────────────────────────────┐
     * │ NO PERMISSION, AND THAT IS THE CHANGE.                                │
     * │                                                                       │
     * │ This was `permissions: ['settings.manage']` + canManageExamSettings,  │
     * │ because /settings was company configuration. It is now the person's   │
     * │ own profile — their name, phone, language, and what role and outlet   │
     * │ they have been given.                                                 │
     * │                                                                       │
     * │ Gating that on a permission would mean HR and every employee had no   │
     * │ way to see or correct their own details, which is the opposite of     │
     * │ what the screen is for. An empty `permissions` array is the           │
     * │ established way this module says "everybody signed in".               │
     * │                                                                       │
     * │ THE GUARD IS NOT REDUNDANT WITH THAT, and the difference is easy to   │
     * │ miss: an empty array skips can(), and can() is what ANDs in           │
     * │ `approved`. Without this line an UNAPPROVED account would be offered  │
     * │ the item. nav.test.ts's "shows an unapproved user nothing but the     │
     * │ always-visible items" failed the instant the permission was removed,  │
     * │ which is exactly what that test is for. It mirrors the                │
     * │ requireApproved() inside loadMyProfile().                             │
     * └───────────────────────────────────────────────────────────────────────┘
     */
    permissions: [],
    guard: (claims) => claims.approved,
  },
]

/**
 * Drop everything a client must not receive.
 *
 * The guard has already run by the time this is called — `isVisible` evaluated
 * it — so this carries no authorisation weight. It exists solely to keep the
 * predicate on the server side of the boundary.
 *
 * Explicit field-by-field rather than a destructured rest, because a rest
 * spread would silently forward any field added to NavItemConfig later. The
 * next `guard`-shaped property would then reach the client exactly as this one
 * did, and typecheck and build would both pass again.
 */
function toClientItem(item: NavItemConfig, claims: AppClaims): NavItem {
  // Field by field, still — see the box above. `activeFor` is a string array
  // and therefore safe to forward; `permissions`, `guard`, `hrefFor` and
  // `mobile` are not forwarded and must never be.
  return {
    /*
     * THE ONE PLACE hrefFor IS EVALUATED, and it is deliberately here rather
     * than in the three list functions.
     *
     * visibleNavItems, visibleFootItems and mobileNavItems all end in
     * `.map(toClientItem)`. Resolving in the callers would mean writing the
     * same line three times, and getting it right in two of them is a real
     * failure mode with a real symptom: HR's tab bar would carry
     * /papers/generate while HR's sidebar carried /history. nav.test.ts's
     * "never hides a capped tab from the sidebar as well" is what catches
     * exactly that, and one evaluation site makes it impossible.
     */
    href: item.hrefFor?.(claims) ?? item.href,
    labelKey: item.labelKey,
    shortLabelKey: item.shortLabelKey,
    icon: item.icon,
    /*
     * activeFor is forwarded UNCHANGED, whatever the href resolved to.
     *
     * useIsActive() is `matches(href) || any(matches(activeFor))`, so this
     * array is what keeps the Papers item lit on /history for somebody whose
     * href is /papers/generate — and lit on /papers for somebody whose href is
     * /history. Narrowing it to "the routes this viewer can open" would make
     * the sidebar go dark on the paper page, which is the bug activeFor was
     * added to fix in the first place.
     */
    ...(item.activeFor ? { activeFor: item.activeFor } : {}),
  }
}

/** Everything the sidebar and the mobile bar filter against. */
export function visibleNavItems(claims: AppClaims): NavItem[] {
  return NAV_ITEMS.filter((item) => isVisible(item, claims)).map((i) => toClientItem(i, claims))
}

export function visibleFootItems(claims: AppClaims): NavItem[] {
  return SIDEBAR_FOOT.filter((item) => isVisible(item, claims)).map((i) => toClientItem(i, claims))
}

/**
 * The mobile tab bar: five slots, in the Stitch order.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ FILTERED, NOT TRUNCATED. A Chef holds no bank.* permission, so the        │
 * │ Questions tab is ABSENT for them rather than present-and-refusing — which │
 * │ is what the mobile design shows, and what the permission rule requires.   │
 * │                                                                           │
 * │ That means the bar renders four tabs for a Chef and five for an Editor.   │
 * │ The layout distributes them evenly rather than assuming five, so neither  │
 * │ case looks like something is missing.                                     │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
/**
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ FIVE, ENFORCED — BECAUSE MARKING ITEMS `mobile` CANNOT BOUND THE TOTAL.   │
 * │                                                                           │
 * │ Every item here is gated on a permission, so the count depends on WHO is  │
 * │ looking. A Super Admin holds all of them, so no amount of care choosing   │
 * │ which items are `mobile` can keep their bar at five — it is six the       │
 * │ moment a sixth mobile item exists anywhere in the list.                   │
 * │                                                                           │
 * │ MobileTabBar gives each tab flex-1, so an over-full bar does not break;   │
 * │ it shrinks every label until they truncate, which is worse than an        │
 * │ honest cap because nothing looks wrong.                                   │
 * │                                                                           │
 * │ DECLARATION ORDER IS THE PRIORITY, and the sidebar always carries the     │
 * │ complete list — nothing is unreachable, it is one tap further away.       │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
const MOBILE_TABS = 5

export function mobileNavItems(claims: AppClaims): NavItem[] {
  return NAV_ITEMS.filter((item) => item.mobile && isVisible(item, claims))
    .slice(0, MOBILE_TABS)
    // Same resolution the sidebar gets. The .slice() runs BEFORE this, so the
    // cap is unaffected by href resolution — membership is decided by
    // `mobile` and isVisible(), neither of which this touches.
    .map((i) => toClientItem(i, claims))
}

function isVisible(item: NavItemConfig, claims: AppClaims): boolean {
  const permitted =
    item.permissions.length === 0 || item.permissions.some((p) => can(claims, p))
  if (!permitted) return false

  // ANDed, never ORed: the guard exists to REMOVE an item the permission would
  // have allowed, so an OR would defeat its only purpose.
  return item.guard ? item.guard(claims) : true
}
