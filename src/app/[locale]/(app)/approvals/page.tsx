import { redirect } from '@/lib/i18n/navigation'

/**
 * Approvals moved into the Users section (/users/approvals) — the same work
 * as the directory beside it. This address keeps working for anything that
 * linked or bookmarked it.
 */
export default async function ApprovalsRedirect({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  redirect({ href: '/users/approvals', locale })
}
