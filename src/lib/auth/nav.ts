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

export type NavIcon =
  | 'dashboard'
  | 'bank'
  | 'generate'
  | 'history'
  | 'editors'
  | 'settings'
  | 'guide'
  | 'approvals'
  | 'topics'
  | 'import'
  | 'profile'
  | 'myExams'
  | 'results'
  | 'exams'
  | 'evaluate'
  | 'liveExams'

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
    // The Super Admin lockout. See the box on `guard`.
    guard: canOpenQuestionBank,
    mobile: true,
  },
  {
    href: '/questions/topics',
    labelKey: 'topics',
    icon: 'topics',
    permissions: ['bank.write'],
    // Inside the Question Bank subtree, so the layout gates it too. The guard
    // is repeated here because the NAV decides visibility and the LAYOUT
    // decides access, and a super admin must fail both.
    guard: canOpenQuestionBank,
  },
  {
    href: '/questions/import',
    labelKey: 'import',
    icon: 'import',
    // bank.import, not bank.write: importing 3,000 questions at once is a
    // different act from editing one, and 0053 keys them separately.
    permissions: ['bank.import', 'bank.write'],
    guard: canOpenQuestionBank,
  },
  {
    href: '/papers/generate',
    labelKey: 'generate',
    icon: 'generate',
    permissions: ['papers.generate'],
    mobile: true,
  },
  {
    href: '/history',
    labelKey: 'history',
    icon: 'history',
    permissions: ['papers.read_history'],
    /*
     * NOT in the mobile bar, since Live exams took the fifth slot.
     *
     * The bar holds five and adding Live exams made six for a Chef and an
     * Editor. Exam History is the one that gives way: it is where papers are
     * reviewed, downloaded and printed — a desk task, at a desk, next to a
     * printer. Live exams is the opposite: the thing somebody checks on a
     * phone, mid-service, to see whether their staff have sat the paper.
     *
     * tests/unit/nav.test.ts asserts the cap so this cannot creep back.
     */
  },
  /*
   * ┌─────────────────────────────────────────────────────────────────────────┐
   * │ /guide IS HERE NOW, AND THE NOTE THAT USED TO SIT IN ITS PLACE SAID     │
   * │ EXACTLY WHY IT COULD NOT BE.                                            │
   * │                                                                         │
   * │ The cookbook library is the EDITOR's reference material while writing    │
   * │ questions, so it belongs under bank.read beside the Question Bank. It    │
   * │ could not go there while the route and all eight of 0048's row and       │
   * │ storage policies were keyed on questions.read / questions.import — keys  │
   * │ a Chef holds and an Editor does not. A nav entry would have handed an    │
   * │ Editor a link that 500s, and relaxing only the route check would have    │
   * │ shown them an empty library with no error at all.                        │
   * │                                                                         │
   * │ 0065 re-keyed all eight policies to accept EITHER vocabulary and         │
   * │ src/lib/auth/guide-access.ts does the same at the application boundary,  │
   * │ so the promise this list makes is now one the route keeps for both.      │
   * └─────────────────────────────────────────────────────────────────────────┘
   */
  {
    href: '/guide',
    labelKey: 'guide',
    icon: 'guide',
    permissions: ['bank.read', 'questions.read'],
  },
  /*
   * ┌─────────────────────────────────────────────────────────────────────────┐
   * │ THE CANDIDATE'S TWO ITEMS, AND WHY THEY WERE MISSING FOR SO LONG.       │
   * │                                                                         │
   * │ Every entry above is something a Chef or an Editor does. An Employee    │
   * │ holds none of those permissions, so this list rendered exactly one item │
   * │ for them — Dashboard — and /my-exams and /results were reachable only   │
   * │ by typing the address. Both routes have existed and returned 200 the    │
   * │ whole time; nothing linked to them.                                     │
   * │                                                                         │
   * │ That was survivable while papers were printed, because a candidate had  │
   * │ nothing to do in the app. Publishing a paper as an online exam is what  │
   * │ makes it a defect: the exam would go live, be assigned, and the person  │
   * │ sitting it would open the app and see an empty dashboard.               │
   * │                                                                         │
   * │ attempts.take and attempts.read_own, not one permission for both: a     │
   * │ Chef holds read_own (they can see their own results) but NOT take, and  │
   * │ must not be offered a "My Exams" link to a list that is always empty.   │
   * └─────────────────────────────────────────────────────────────────────────┘
   */
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
  /*
   * ┌─────────────────────────────────────────────────────────────────────────┐
   * │ THE OTHER HALF OF THE LOOP — WITHOUT THESE THE FEATURE DEAD-ENDS.       │
   * │                                                                         │
   * │ A published paper always contains short answers (the 80/20 blueprint    │
   * │ guarantees it), so every submitted attempt stops at `evaluating` and    │
   * │ waits for a person. With no link to /evaluate, that person had no way   │
   * │ to reach the queue: papers could be published and sat, and the results  │
   * │ would simply never come out.                                            │
   * │                                                                         │
   * │ /exams for the same reason at the other end — published exams were      │
   * │ reachable only by following the link on the paper that made them.       │
   * │                                                                         │
   * │ /verify and /reports stay out. Paper-backed exams publish with          │
   * │ verification_mode 'single', so nothing lands in the verify queue, and   │
   * │ analytics is a separate piece of work.                                  │
   * └─────────────────────────────────────────────────────────────────────────┘
   */
  /*
   * ┌─────────────────────────────────────────────────────────────────────────┐
   * │ LIVE EXAMS SITS ABOVE EXAMS, AND THE ORDER IS THE POINT.                │
   * │                                                                         │
   * │ /exams is the full list — every exam ever, in any state, including the  │
   * │ legacy rule-drawn ones. /exams/live is the handful running right now,   │
   * │ which is the only one that is ever urgent.                              │
   * │                                                                         │
   * │ Upcoming and Closed are deliberately NOT nav items. They are two clicks │
   * │ from here via the tab bar on the section itself, and three sibling      │
   * │ entries for one concept would crowd out the things a chef opens daily.  │
   * └─────────────────────────────────────────────────────────────────────────┘
   */
  {
    href: '/exams/live',
    labelKey: 'liveExams',
    icon: 'liveExams',
    permissions: ['exams.read'],
    mobile: true,
  },
  {
    href: '/exams',
    labelKey: 'exams',
    icon: 'exams',
    permissions: ['exams.read'],
  },
  {
    href: '/evaluate',
    labelKey: 'evaluate',
    icon: 'evaluate',
    permissions: ['evaluation.evaluate'],
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
  return { href: item.href, labelKey: item.labelKey, icon: item.icon }
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
