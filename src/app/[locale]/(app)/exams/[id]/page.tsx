import { notFound } from 'next/navigation'
import { getTranslations, getFormatter } from 'next-intl/server'
import { requirePermission } from '@/lib/auth/guards'
import { can } from '@/lib/auth/claims'
import { Link } from '@/lib/i18n/navigation'
import { createClient } from '@/lib/supabase/server'
import { dbId } from '@/lib/db/id'
import { examState } from '@/lib/exams/state'
import {
  loadParticipation,
  loadParticipants,
  loadScoreSpread,
} from '@/server/exams/live'
import { ExamMonitoring } from '@/components/exams/exam-monitoring'
import { LiveRefresh } from '@/components/exams/live-refresh'
import { ExamStateBadge } from '@/components/exams/exam-state-badge'
import { buttonVariants } from '@/components/ui/button'
import { ArrowLeftIcon, FileTextIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * /exams/[id] — the monitoring page for one exam.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THIS USED TO REDIRECT TO THE PAPER PAGE, AND THAT WAS THE WRONG ANSWER    ║
 * ║ to the question a person clicking a live exam is asking. The paper page   ║
 * ║ is about the PAPER — publishing, audience, downloads — with monitoring    ║
 * ║ as one section far down. A chef clicking a running exam wants exactly     ║
 * ║ one thing: WHO IS SITTING IT AND HOW IS IT GOING. So this route now IS    ║
 * ║ that page, and the paper's own screen is one button away for the rest.    ║
 * ║                                                                           ║
 * ║ Everything on it is the same ExamMonitoring the paper page embeds —       ║
 * ║ one monitoring implementation, two doors.                                 ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */
export default async function ExamMonitorPage({
  params,
}: {
  params: Promise<{ id: string }>
}) {
  const claims = await requirePermission('exams.read')
  const { id } = await params
  const t = await getTranslations('exams')
  const format = await getFormatter()

  const parsed = dbId().safeParse(id)
  if (!parsed.success) notFound()

  const supabase = await createClient()
  // RLS-scoped: an exam the caller may not read comes back null → 404.
  const { data: exam } = await supabase
    .from('exams')
    .select('id, title, status, opens_at, closes_at, duration_minutes, question_count, total_marks, pass_mark_percent, paper_id, brand_id')
    .eq('id', parsed.data)
    .is('deleted_at', null)
    .maybeSingle()

  if (!exam) notFound()

  const canMonitor = can(claims, 'attempts.read_all') || can(claims, 'attempts.read_team')
  const state = examState({ status: exam.status, opensAt: exam.opens_at, closesAt: exam.closes_at })

  const [brand, participation, participants, spread] = await Promise.all([
    exam.brand_id
      ? supabase.from('brands').select('name').eq('id', exam.brand_id).maybeSingle()
      : Promise.resolve({ data: null }),
    loadParticipation(exam.id),
    canMonitor ? loadParticipants(exam.id) : Promise.resolve([]),
    canMonitor ? loadScoreSpread(exam.id) : Promise.resolve(null),
  ])

  const when = (iso: string | null) =>
    iso
      ? format.dateTime(new Date(iso), {
          day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
        })
      : '—'

  return (
    <div className="space-y-6">
      {/* Live numbers stay live — mounted only while the window is open. */}
      {state === 'live' && <LiveRefresh />}

      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            href="/exams/live"
            className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), '-ml-2 mb-2')}
          >
            <ArrowLeftIcon className="size-4" />
            {t('liveTitle')}
          </Link>
          <h1 className="flex flex-wrap items-center gap-3 text-2xl font-semibold tracking-tight">
            {exam.title}
            <ExamStateBadge state={state} label={t((state === 'live' ? 'stateLive' : state === 'scheduled' ? 'stateScheduled' : state === 'closed' ? 'stateClosed' : state === 'draft' ? 'stateDraft' : 'stateCancelled') as 'stateLive')} />
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {[
              brand.data?.name,
              t('cardDuration') + ' ' + exam.duration_minutes + ' ' + t('minutesUnit'),
              exam.question_count + ' ' + t('cardQuestions'),
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
          <p className="text-sm text-muted-foreground">
            {t('cardStarts')}: {when(exam.opens_at)} · {t('cardDeadline')}: {when(exam.closes_at)}
          </p>
        </div>

        {/* The paper's own page — publishing, audience, downloads. */}
        {exam.paper_id && (
          <Link
            href={`/history/${exam.paper_id}`}
            className={buttonVariants({ variant: 'outline', size: 'sm' })}
          >
            <FileTextIcon className="size-4" />
            {t('paperPageLink')}
          </Link>
        )}
      </div>

      <ExamMonitoring
        participation={participation}
        spread={spread}
        participants={participants}
        canSeeTable={canMonitor}
      />
    </div>
  )
}
