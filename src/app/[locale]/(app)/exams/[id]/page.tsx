import { notFound } from 'next/navigation'
import { redirect } from '@/lib/i18n/navigation'
import { requirePermission } from '@/lib/auth/guards'
import { createClient } from '@/lib/supabase/server'
import { dbId } from '@/lib/db/id'

/**
 * /exams/[id] — a resolver, not a page.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ AN EXAM'S DETAIL SCREEN IS ITS PAPER'S PAGE (/history/[paperId]), where   │
 * │ monitoring, assignments and downloads already live. But everything that   │
 * │ HOLDS an exam holds its exam id — the live cards, the monitoring          │
 * │ back-link, notification links — and the live card had been linking to     │
 * │ this address since before it existed: a 404 behind every card title,      │
 * │ found while wiring monitoring rather than by anyone reporting it.         │
 * │                                                                           │
 * │ One lookup, one redirect, RLS-scoped: an exam the caller may not read     │
 * │ comes back null and lands on 404, indistinguishable from absent.          │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export default async function ExamRedirectPage({
  params,
}: {
  params: Promise<{ id: string; locale: string }>
}) {
  await requirePermission('exams.read')
  const { id, locale } = await params

  const parsed = dbId().safeParse(id)
  if (!parsed.success) notFound()

  const supabase = await createClient()
  const { data } = await supabase
    .from('exams')
    .select('paper_id')
    .eq('id', parsed.data)
    .is('deleted_at', null)
    .maybeSingle()

  if (!data?.paper_id) notFound()

  redirect({ href: `/history/${data.paper_id}`, locale })
}
