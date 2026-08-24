import { redirect } from 'next/navigation'
import { getAppClaims } from '@/lib/auth/claims'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Exam Mode — the shell that isn't one.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ A SEPARATE ROUTE GROUP, BECAUSE A CHILD LAYOUT CANNOT REMOVE A PARENT.    ║
 * ║                                                                           ║
 * ║ Layouts compose in the App Router: nesting one inside (app) would have    ║
 * ║ drawn the sidebar, the top bar and the mobile tab bar and then tried to   ║
 * ║ hide them with CSS. That is not a controlled examination environment, it  ║
 * ║ is the same room with the doors painted over — the links stay focusable,  ║
 * ║ reachable by keyboard, and announced to a screen reader.                  ║
 * ║                                                                           ║
 * ║ (exam) is a route GROUP, so the URL is untouched: /en/attempt/{id} is     ║
 * ║ exactly where it was, and every existing link and test still resolves.    ║
 * ║                                                                           ║
 * ║ THE TWO GATES ARE COPIED DELIBERATELY, NOT SHARED.                        ║
 * ║ Leaving (app) means leaving its verification and approval checks, and an  ║
 * ║ exam is the last place to discover that. They are repeated here in the    ║
 * ║ same order for the same reasons — see the box in (app)/layout.tsx. The    ║
 * ║ page itself still calls requirePermission('attempts.take'), and RLS backs ║
 * ║ every read underneath. Three layers, innermost authoritative.             ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */
export default async function ExamLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  const claims = await getAppClaims()

  // Verification first, approval second — the order of the flow, and the order
  // the proxy and (app) both use.
  if (!claims.email_verified) {
    redirect(`/${locale}/verify-email`)
  }

  if (!claims.approved) {
    redirect(`/${locale}/pending`)
  }

  /*
   * min-h-svh, not min-h-screen: on a phone `vh` is the tallest the viewport
   * ever gets, so the browser's collapsing address bar leaves the submit
   * button under the fold until the page is scrolled. `svh` is the smallest,
   * which is the one that is always actually visible.
   *
   * The safe-area padding is on the exam's own header and footer rather than
   * here, so the background still reaches into the notch and the home
   * indicator — the whole point of viewport-fit=cover.
   */
  return <div className="flex min-h-svh flex-col bg-background">{children}</div>
}
