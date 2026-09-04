import { redirect } from '@/lib/i18n/navigation'

/**
 * /team/[id] shipped one iteration before /users/[id] existed and pointed at
 * the same person. One canonical page now; this address keeps working for
 * anything that linked it.
 */
export default async function TeamRedirect({
  params,
}: {
  params: Promise<{ id: string; locale: string }>
}) {
  const { id, locale } = await params
  redirect({ href: `/users/${id}`, locale })
}
