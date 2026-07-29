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
  | 'learning'
  | 'reports'
  | 'approvals'
  | 'admin'

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
  { href: '/learning', labelKey: 'learning', icon: 'learning', permissions: ['learning.read'] },
  { href: '/reports', labelKey: 'reports', icon: 'reports', permissions: ['reports.read_own', 'reports.read_team', 'reports.read_all'] },
  { href: '/approvals', labelKey: 'approvals', icon: 'approvals', permissions: ['users.approve'] },
  { href: '/admin', labelKey: 'admin', icon: 'admin', permissions: ['org.manage', 'roles.manage', 'settings.manage', 'audit.read'] },
]

export function visibleNavItems(claims: AppClaims): NavItem[] {
  return NAV_ITEMS.filter(
    (item) => item.permissions.length === 0 || item.permissions.some((p) => can(claims, p)),
  )
}
