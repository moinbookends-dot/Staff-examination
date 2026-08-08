import { getAppClaims } from '@/lib/auth/claims'
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

  return <>{children}</>
}
