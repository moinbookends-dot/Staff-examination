import { redirect } from '@/lib/i18n/navigation'
import { getUser } from '@/lib/supabase/server'

/**
 * Root entry. Not a landing page — this is an internal tool with no anonymous
 * audience, so there is nothing to show a signed-out visitor except the door.
 *
 * Middleware already gates /dashboard, so both branches converge safely; this
 * just avoids a pointless extra redirect hop for signed-in staff.
 *
 * Uses the locale-aware redirect from @/lib/i18n/navigation, not next/navigation
 * — the raw one drops the locale prefix and silently resets the user's language.
 */
export default async function RootPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  const user = await getUser()

  redirect({ href: user ? '/dashboard' : '/login', locale })
}
