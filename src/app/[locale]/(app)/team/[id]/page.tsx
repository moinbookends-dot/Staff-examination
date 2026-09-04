import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { requireAnyPermission } from '@/lib/auth/guards'
import { Link } from '@/lib/i18n/navigation'
import { getCandidateStats } from '@/server/actions/reports'
import { getCandidateHistory } from '@/server/actions/monitoring'
import { createClient } from '@/lib/supabase/server'
import { PerformancePanel } from '@/components/team/performance-panel'
import { buttonVariants } from '@/components/ui/button'
import { ArrowLeftIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { dbId } from '@/lib/db/id'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * One person's examination record.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ REACH IS DECIDED TWICE, AND ONLY THE SECOND ONE COUNTS. The guard here    ║
 * ║ keeps out anyone below team scope — a legible fast fail. The actual       ║
 * ║ boundary is candidate_attempt_history() and candidate_stats(), which      ║
 * ║ re-verify the TARGET against analytics_scope(): same company always,      ║
 * ║ same outlet unless the caller holds reports.read_all. A chef probing a    ║
 * ║ profile id from another outlet gets empty hands from the database, not    ║
 * ║ from this page's goodwill.                                                ║
 * ║                                                                           ║
 * ║ The profile line itself is read through the CALLER'S OWN client, so RLS   ║
 * ║ answers whether they may see this person at all — a null profile and an   ║
 * ║ out-of-reach target both land on the same 404.                            ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */
export default async function TeamMemberPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  await requireAnyPermission(['reports.read_team', 'reports.read_all'])
  const { id } = await params
  const t = await getTranslations('perf')

  const parsed = dbId().safeParse(id)
  if (!parsed.success) notFound()

  const supabase = await createClient()
  const [{ data: profile }, stats, history] = await Promise.all([
    supabase
      .from('profiles')
      .select('id, full_name, email')
      .eq('id', parsed.data)
      .maybeSingle(),
    getCandidateStats(parsed.data),
    getCandidateHistory(parsed.data),
  ])

  // Absent and out-of-reach are deliberately indistinguishable.
  if (!profile || !stats) notFound()

  // Department and outlet names, RLS-scoped like everything else on this page.
  const { data: place } = await supabase
    .from('profiles')
    .select('department_id, outlet_id')
    .eq('id', parsed.data)
    .maybeSingle()
  const [dept, outlet] = await Promise.all([
    place?.department_id
      ? supabase.from('departments').select('name').eq('id', place.department_id).maybeSingle()
      : Promise.resolve({ data: null }),
    place?.outlet_id
      ? supabase.from('outlets').select('name').eq('id', place.outlet_id).maybeSingle()
      : Promise.resolve({ data: null }),
  ])

  return (
    <div className="space-y-6">
      <div>
        <Link
          href="/reports"
          className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), '-ml-2 mb-2')}
        >
          <ArrowLeftIcon className="size-4" />
          {t('backToReports')}
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight">
          {profile.full_name || profile.email}
        </h1>
        <p className="text-sm text-muted-foreground">
          {[dept.data?.name, outlet.data?.name].filter(Boolean).join(' · ') || profile.email}
        </p>
      </div>

      <PerformancePanel rows={history} />
    </div>
  )
}
