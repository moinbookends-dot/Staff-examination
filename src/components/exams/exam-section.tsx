import { getTranslations, getFormatter } from 'next-intl/server'
import { ClipboardListIcon } from 'lucide-react'
import { Link } from '@/lib/i18n/navigation'
import { PageHeader } from '@/components/ui/page-header'
import { EmptyState } from '@/components/ui/empty-state'
import { Card, CardContent } from '@/components/ui/card'
import { LiveExamCard } from './live-exam-card'
import { cn } from '@/lib/utils'
import type { ExamState } from '@/lib/exams/state'
import type { LiveExamRow } from '@/server/exams/live'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The shell shared by /exams/live, /exams/upcoming and /exams/closed.
 *
 * One component rather than three near-identical pages. The three differ only
 * in which bucket they render and what the empty state says; everything else —
 * the tabs, the card, the date formatting, the translated state labels — is
 * the same, and three copies of it would drift the first time one changed.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const TABS: { state: Exclude<ExamState, 'draft' | 'cancelled'>; href: string }[] = [
  { state: 'live', href: '/exams/live' },
  { state: 'scheduled', href: '/exams/upcoming' },
  { state: 'closed', href: '/exams/closed' },
]

export async function ExamSection({
  current,
  rows,
  counts,
}: {
  current: Exclude<ExamState, 'draft' | 'cancelled'>
  rows: LiveExamRow[]
  counts: Record<string, number>
}) {
  const t = await getTranslations('exams')
  const format = await getFormatter()

  const titleKey = current === 'live' ? 'liveTitle' : current === 'scheduled' ? 'upcomingTitle' : 'closedTitle'
  const subKey = current === 'live' ? 'liveSubtitle' : current === 'scheduled' ? 'upcomingSubtitle' : 'closedSubtitle'
  const emptyKey = current === 'live' ? 'liveEmpty' : current === 'scheduled' ? 'upcomingEmpty' : 'closedEmpty'
  const hintKey = current === 'live' ? 'liveEmptyHint' : current === 'scheduled' ? 'upcomingEmptyHint' : 'closedEmptyHint'

  const stateLabel = (s: ExamState) =>
    t(
      (s === 'live' ? 'stateLive'
        : s === 'scheduled' ? 'stateScheduled'
        : s === 'closed' ? 'stateClosed'
        : s === 'draft' ? 'stateDraft'
        : 'stateCancelled') as 'stateLive',
    )

  const formatDate = (iso: string) =>
    format.dateTime(new Date(iso), {
      day: 'numeric', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    })

  const labels = {
    paper: t('cardPaper'),
    questions: t('cardQuestions'),
    marks: t('cardMarks'),
    duration: t('cardDuration'),
    starts: t('cardStarts'),
    deadline: t('cardDeadline'),
    attempts: t('cardAttempts'),
    submitted: t('cardSubmitted'),
    inProgress: t('cardInProgress'),
    notStarted: t('cardNotStarted'),
    ofEmployees: t('cardOfEmployees'),
    noAudience: t('cardNoAudience'),
    passed: t('monPassedN'),
    failed: t('monFailedN'),
    avg: t('monAvg'),
    best: t('monBest'),
    worst: t('monWorst'),
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t(titleKey as 'liveTitle')} description={t(subKey as 'liveSubtitle')} />

      {/*
        Tabs as links, not client state. Each section is its own route so it can
        be linked to, bookmarked and opened in a new tab — which is what a chef
        watching one exam during service actually does.
      */}
      <nav className="flex flex-wrap gap-1 border-b" aria-label={t('sectionsLabel')}>
        {TABS.map((tab) => {
          const active = tab.state === current
          return (
            <Link
              key={tab.href}
              href={tab.href}
              aria-current={active ? 'page' : undefined}
              className={cn(
                // Same 44px floor as SectionTabs — these are the only route
                // between Live, Upcoming and Closed on a phone.
                '-mb-px flex min-h-11 items-center border-b-2 px-3 py-2 text-body-sm transition-colors md:min-h-0',
                active
                  ? 'border-primary font-medium text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {stateLabel(tab.state)}
              <span className="ml-1.5 tabular-nums text-muted-foreground">
                {counts[tab.state] ?? 0}
              </span>
            </Link>
          )
        })}
      </nav>

      {rows.length === 0 ? (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={ClipboardListIcon}
              message={t(emptyKey as 'liveEmpty')}
              hint={t(hintKey as 'liveEmptyHint')}
            />
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {rows.map((exam) => (
            <LiveExamCard
              key={exam.id}
              exam={exam}
              stateLabel={stateLabel(exam.state)}
              labels={labels}
              formatDate={formatDate}
            />
          ))}
        </div>
      )}
    </div>
  )
}
