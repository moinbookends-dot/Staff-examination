import { getTranslations } from 'next-intl/server'
import { getAppClaims, can } from '@/lib/auth/claims'
import { SectionTabs } from '@/components/shell/section-tabs'
import { AuthorizationError, requireApproved } from '@/lib/auth/guards'
import { canOpenQuestionBank } from '@/lib/auth/bank-access'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The Question Bank gate, for the WHOLE /questions subtree.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ A LAYOUT, NOT A CHECK REPEATED IN EVERY PAGE.                             ║
 * ║                                                                           ║
 * ║ /questions was gated and /questions/new, /questions/[id],                 ║
 * ║ /questions/[id]/translations and /questions/quality were not — they still ║
 * ║ carried requirePermission('questions.read'), a permission the CHEF role   ║
 * ║ holds. So a chef could not see a link to the Question Bank, could not     ║
 * ║ open /questions… and could open /questions/new and edit the bank.         ║
 * ║                                                                           ║
 * ║ Gating each page individually is what produced that gap, and it would     ║
 * ║ produce it again the next time a sub-route is added. A layout runs for    ║
 * ║ every descendant, so a new page under this directory is protected before  ║
 * ║ it is written.                                                           ║
 * ║                                                                           ║
 * ║ THE PREDICATE, NOT THE PERMISSION: has_perm() short-circuits true for     ║
 * ║ super_admin, so requirePermission('bank.read') would admit the one role   ║
 * ║ deliberately excluded. canOpenQuestionBank is the governance boundary and ║
 * ║ is the same function the nav and the server actions call.                 ║
 * ║                                                                           ║
 * ║ This is a UI boundary. RLS is the real one — a chef holds no policy on    ║
 * ║ bank_questions at all — and neither replaces the other.                   ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */
export default async function QuestionBankLayout({
  children,
}: {
  children: React.ReactNode
}) {
  await requireApproved()

  const claims = await getAppClaims()
  if (!canOpenQuestionBank(claims)) {
    throw new AuthorizationError('The Question Bank is available to Editors only.', 'bank.read')
  }

  const t = await getTranslations('nav')

  /*
   * ┌───────────────────────────────────────────────────────────────────────────┐
   * │ TOPICS AND IMPORT MOVED HERE FROM THE SIDEBAR.                            │
   * │                                                                           │
   * │ All three were separate nav entries, and useIsActive() lit /questions      │
   * │ while on either child — so the sidebar showed two items highlighted at     │
   * │ once and spent three rows on one section.                                  │
   * │                                                                           │
   * │ The tabs live in the LAYOUT rather than in each page so a new sub-route    │
   * │ inherits them, exactly as it already inherits the guard above.             │
   * │                                                                           │
   * │ `exact` on Questions: /questions is a prefix of both siblings, so without  │
   * │ it every tab would read as active on the Import screen.                    │
   * └───────────────────────────────────────────────────────────────────────────┘
   *
   * Import is offered only to somebody who may actually import — a Super Admin
   * reaching the bank still holds bank.import through the has_perm()
   * short-circuit, so this is about role, not about hiding a broken link.
   */
  const tabs = [
    { href: '/questions', label: t('questions'), exact: true },
    { href: '/questions/topics', label: t('topics') },
    ...(can(claims, 'bank.import') ? [{ href: '/questions/import', label: t('import') }] : []),
  ]

  return (
    <div className="space-y-6">
      <SectionTabs tabs={tabs} label={t('bank')} />
      {children}
    </div>
  )
}
