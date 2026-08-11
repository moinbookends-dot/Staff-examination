import type { Permission } from './permissions'
import type { AppClaims } from './can'
import { can } from './can'
import { canManageExamSettings, canOpenQuestionBank } from './bank-access'

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
   * │ Question Bank is the item permissions alone cannot gate. A Super      │
   * │ Admin passes can(claims, 'bank.read') — has_perm() short-circuits for │
   * │ them and claims.ts mirrors it — yet they are deliberately locked out  │
   * │ of the bank. There is no way to express that as a permission, because │
   * │ the model has no concept of a denial.                                 │
   * │                                                                       │
   * │ So the item carries canOpenQuestionBank as its guard, which is the    │
   * │ SAME function the route and the server actions call. One rule, three  │
   * │ enforcement points, no chance of the nav disagreeing with the page.   │
   * └───────────────────────────────────────────────────────────────────────┘
   */
  guard?: (claims: AppClaims) => boolean
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
    mobile: true,
    /*
     * /history does NOT share a prefix with /papers/generate, so without this
     * the Papers item would go dark the moment somebody opened a paper — the
     * sidebar would say they were nowhere.
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
    permissions: ['settings.manage'],
    guard: canManageExamSettings,
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
function toClientItem(item: NavItemConfig): NavItem {
  // Field by field, still — see the box above. `activeFor` is a string array
  // and therefore safe to forward; `permissions`, `guard` and `mobile` are not
  // forwarded and must never be.
  return {
    href: item.href,
    labelKey: item.labelKey,
    icon: item.icon,
    ...(item.activeFor ? { activeFor: item.activeFor } : {}),
  }
}

/** Everything the sidebar and the mobile bar filter against. */
export function visibleNavItems(claims: AppClaims): NavItem[] {
  return NAV_ITEMS.filter((item) => isVisible(item, claims)).map(toClientItem)
}

export function visibleFootItems(claims: AppClaims): NavItem[] {
  return SIDEBAR_FOOT.filter((item) => isVisible(item, claims)).map(toClientItem)
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
    .map(toClientItem)
}

function isVisible(item: NavItemConfig, claims: AppClaims): boolean {
  const permitted =
    item.permissions.length === 0 || item.permissions.some((p) => can(claims, p))
  if (!permitted) return false

  // ANDed, never ORed: the guard exists to REMOVE an item the permission would
  // have allowed, so an OR would defeat its only purpose.
  return item.guard ? item.guard(claims) : true
}
