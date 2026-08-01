import type { Permission } from './permissions'
import type { AppClaims } from './claims'
import { can } from './claims'

/**
 * Navigation definition, gated by permission.
 *
 * Nav is derived from the SAME permission keys the server actions and RLS
 * policies use, so a link can never appear for something the user cannot
 * actually do. Hand-maintaining a parallel "which roles see which menu"
 * mapping is how UIs drift into showing buttons that 403.
 *
 * Hiding a link is presentation, not security — every destination re-checks
 * via requirePermission().
 */

/**
 * Icons are named, not imported.
 *
 * NAV_ITEMS is built in a server component and handed to <AppNav> — a client
 * component — so every field has to survive serialisation. A lucide component
 * reference does not; a string does. app-nav.tsx owns the string → component
 * map, which also keeps the icon library out of the auth layer entirely.
 */
export type NavIcon =
  | 'dashboard'
  | 'myExams'
  | 'questions'
  | 'exams'
  | 'evaluate'
  | 'verify'
  | 'results'
  | 'reports'
  | 'approvals'

export interface NavItem {
  href: string
  labelKey: string          // key under the `nav` namespace in messages/*.json
  icon: NavIcon
  /** Any one of these grants visibility. */
  permissions: Permission[]
}

export const NAV_ITEMS: NavItem[] = [
  { href: '/dashboard', labelKey: 'dashboard', icon: 'dashboard', permissions: [] }, // always visible
  // Where a candidate lives. Separate from /exams, which is the authoring side
  // and gated on exams.read — an employee holds attempts.take and no more, so
  // the two audiences never share a screen.
  { href: '/my-exams', labelKey: 'myExams', icon: 'myExams', permissions: ['attempts.take'] },
  { href: '/questions', labelKey: 'questions', icon: 'questions', permissions: ['questions.read'] },
  { href: '/exams', labelKey: 'exams', icon: 'exams', permissions: ['exams.read'] },
  { href: '/evaluate', labelKey: 'evaluate', icon: 'evaluate', permissions: ['evaluation.evaluate'] },
  { href: '/verify', labelKey: 'verify', icon: 'verify', permissions: ['evaluation.verify'] },
  { href: '/results', labelKey: 'results', icon: 'results', permissions: ['attempts.read_own'] },
  // Labelled Analytics rather than Reports: question quality (M9) moves in
  // beside it, and naming it for the section rather than for the one page it
  // currently holds means the label does not change again when it does.
  { href: '/reports', labelKey: 'reports', icon: 'reports', permissions: ['reports.read_own', 'reports.read_team', 'reports.read_all'] },
  { href: '/approvals', labelKey: 'approvals', icon: 'approvals', permissions: ['users.approve'] },
]

/**
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ TWO ENTRIES REMOVED HERE, AND THEY WERE BOTH 404s.                        │
 * │                                                                           │
 * │ /learning (learning.read) and /admin (org.manage, roles.manage,           │
 * │ settings.manage, audit.read) have been in this list since M2 with no page │
 * │ behind either. Anybody holding those permissions — every chef holds       │
 * │ learning.read — saw a link that broke.                                    │
 * │                                                                           │
 * │ Nothing is lost by removing them: there was nothing there. When Settings  │
 * │ is built it takes /admin's permission set, and the seeded roles regain a  │
 * │ destination that works.                                                   │
 * │                                                                           │
 * │ GUIDE (AI) IS DELIBERATELY NOT ADDED YET. Adding a nav entry before its   │
 * │ route exists is precisely the defect being removed above, and doing it in │
 * │ the same commit that removes two of them would be hard to explain. It     │
 * │ joins this list in the slice that ships the page.                         │
 * │                                                                           │
 * │ Still to merge, each needing page changes rather than a list edit:        │
 * │   /my-exams  into Exams     — one route branching on attempts.take        │
 * │   /verify    into Evaluate  — two stages of one queue, as tabs            │
 * │   quality    into Analytics — already a sub-route of /questions           │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

export function visibleNavItems(claims: AppClaims): NavItem[] {
  return NAV_ITEMS.filter(
    (item) => item.permissions.length === 0 || item.permissions.some((p) => can(claims, p)),
  )
}
