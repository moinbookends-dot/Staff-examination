import { getTranslations, getFormatter } from 'next-intl/server'
import {
  AwardIcon,
  CheckCircle2Icon,
  ClipboardCheckIcon,
  FileCheck2Icon,
  GaugeIcon,
  InboxIcon,
  ListChecksIcon,
  SendIcon,
  UserRoundCheckIcon,
} from 'lucide-react'
import { requireApproved } from '@/lib/auth/guards'
import { can } from '@/lib/auth/claims'
import { getUser } from '@/lib/supabase/server'
import { listPendingRegistrations } from '@/server/actions/users'
import {
  listEvaluationQueue,
  listVerificationQueue,
  listReleaseQueue,
  type QueueItem,
} from '@/server/actions/evaluation'
import { listMyExams, listMyResults } from '@/server/actions/attempts'
import { getCandidateStats } from '@/server/actions/reports'
import { Link } from '@/lib/i18n/navigation'
import { ExecutiveOverview } from './executive-overview'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import { StatTile } from '@/components/ui/stat-tile'
import { buttonVariants } from '@/components/ui/button'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Role-routed dashboard.
 *
 * One route, different content by permission, rather than /chef/dashboard and
 * /employee/dashboard. Users hold multiple roles (a chef who also does HR
 * reporting), so splitting by role would force an arbitrary choice about which
 * dashboard such a person lands on.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE RULE THIS PAGE IS BUILT ON: A GATE'S KEY MUST BE CHARACTER-IDENTICAL  │
 * │ TO THE GUARD KEY OF THE ACTION IT UNLOCKS.                                │
 * │                                                                           │
 * │ Every fetch below is gated on the exact literal that the action it calls   │
 * │ passes to requirePermission(). Not a superset, not an `||` of two keys     │
 * │ that "obviously" imply each other.                                        │
 * │                                                                           │
 * │ This is not theoretical tidiness. /reports gates <TeamSections> on         │
 * │ `read_team || read_all` and TeamSections calls three actions guarded on    │
 * │ `read_team` ALONE — so /reports and /api/reports/export both return 500    │
 * │ to every HR user, verified against this database. tsc cannot see it:       │
 * │ can(claims, X) and requirePermission(Y) are each individually well-typed.  │
 * │                                                                           │
 * │ It matters more here than anywhere else because this route is the          │
 * │ universal funnel — proxy.ts sends signed-in users here from any auth page, │
 * │ loginAction defaults here, / redirects here, /pending forwards here on     │
 * │ approval, and the "you have been approved" notification links here. There  │
 * │ is no route around it. A throw is not a degraded tile; it is that role     │
 * │ locked out of the product on their first screen.                          │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * KNOWN LIMITATION, recorded rather than hidden: every reader in src/server/
 * actions returns [] on a query failure instead of throwing. On a page made of
 * counts that means a broken query and an empty queue render identically —
 * "Nothing is waiting on you" is shown to somebody whose request actually
 * failed. Fixing it means changing those actions' contracts, which is a
 * deliberate decision for another change, not a side effect of a redesign.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const ROLE_KEYS = ['super_admin', 'chef', 'hr', 'employee']

/** Longest-waiting first. A queue is only useful if it names the oldest thing. */
function oldestFirst(a: QueueItem, b: QueueItem) {
  return (a.submitted_at ?? '').localeCompare(b.submitted_at ?? '')
}

export default async function DashboardPage() {
  const claims = await requireApproved()
  const t = await getTranslations('dashboard')
  const tr = await getTranslations('reports')
  // Reused rather than duplicated: `sitting` already owns every word a
  // candidate reads about an exam, and a second copy under `dashboard` would
  // drift the moment one of them was translated.
  const ts = await getTranslations('sitting')
  const format = await getFormatter()

  // Each of these mirrors the literal inside the action's own requirePermission.
  const canApprove = can(claims, 'users.approve')
  const canEvaluate = can(claims, 'evaluation.evaluate')
  const canVerify = can(claims, 'evaluation.verify')
  const canRelease = can(claims, 'evaluation.publish')
  const canSit = can(claims, 'attempts.take')
  const canSeeOwnResults = can(claims, 'attempts.read_own')
  const canSeeOwnStats = can(claims, 'reports.read_own')
  // The pair, not a superset: getTeamStats and getExamStats are guarded on
  // requireAnyPermission(['reports.read_team', 'reports.read_all']), so this
  // gate lists exactly those two literals. A chef arrives via read_team, HR via
  // read_all — and gating on only one of them is precisely what made /reports
  // 500 for every HR user.
  const seesOverview =
    can(claims, 'reports.read_team') || can(claims, 'reports.read_all')

  // One round of parallel reads. getQuestionStats and getTeamStats are
  // deliberately absent: the first is the most expensive read in the codebase
  // (a company-wide correlation over every answer ever given) and neither
  // answers a question you arrive at a dashboard holding.
  const [user, pending, toEvaluate, toVerify, toRelease, myExams, myResults, myStats] =
    await Promise.all([
      getUser(),
      canApprove ? listPendingRegistrations() : [],
      canEvaluate ? listEvaluationQueue() : [],
      canVerify ? listVerificationQueue() : [],
      canRelease ? listReleaseQueue() : [],
      canSit ? listMyExams() : [],
      canSeeOwnResults ? listMyResults() : [],
      canSeeOwnStats ? getCandidateStats() : null,
    ])

  const fullName =
    typeof user?.user_metadata?.full_name === 'string' ? user.user_metadata.full_name : null

  // Slugs are what the claim carries; these are display names. Unknown slugs
  // fall through to the raw value rather than rendering MISSING_MESSAGE — a
  // company can define its own roles, and a dashboard is not the place to
  // discover that.
  const roleLabels = claims.roles.map((role) =>
    ROLE_KEYS.includes(role) ? t(`roles.${role}` as 'roles.chef') : role,
  )

  const worklist = [
    ...toEvaluate.map((item) => ({ item, kind: 'evaluate' as const })),
    ...toRelease.map((item) => ({ item, kind: 'release' as const })),
    ...toVerify.map((item) => ({ item, kind: 'verify' as const })),
  ]
    .sort((a, b) => oldestFirst(a.item, b.item))
    .slice(0, 5)

  const totalWaiting =
    pending.length + toEvaluate.length + toVerify.length + toRelease.length
  const hasQueues = canApprove || canEvaluate || canVerify || canRelease
  const openExams = myExams.slice(0, 3)
  const recentResults = myResults.slice(0, 4)
  const hasOwnStats = (myStats?.attempts_n ?? 0) > 0

  // Somebody with no queues, no exams and no history. A team member on their
  // first day lands here, from the notification that told them they were
  // approved — so it has to say something true rather than render nothing.
  const emptyEverywhere =
    !hasQueues &&
    !seesOverview &&
    openExams.length === 0 &&
    recentResults.length === 0 &&
    !hasOwnStats

  return (
    <div className="space-y-8">
      <PageHeader
        title={fullName ? t('greeting', { name: fullName }) : t('greetingAnon')}
        description={t('subtitle')}
        actions={
          roleLabels.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {roleLabels.map((role) => (
                <Badge key={role} variant="outline">
                  {role}
                </Badge>
              ))}
            </div>
          ) : (
            <Badge variant="secondary">{t('noRole')}</Badge>
          )
        }
      />

      {emptyEverywhere && (
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={InboxIcon}
              message={t('nothingHere')}
              hint={t('nothingHereHint')}
            />
          </CardContent>
        </Card>
      )}

      {/* ── The manager's numbers ───────────────────────────────────────
          Above the queues on purpose: Stitch leads with the figures, and a
          manager arrives asking "how are we doing" before "what is waiting". */}
      {seesOverview && (
        <ExecutiveOverview claims={claims} pendingCount={canApprove ? pending.length : null} />
      )}

      {/* ── What is waiting on this person ──────────────────────────────── */}
      {hasQueues && (
        <section className="space-y-4">
          <h2 className="font-heading text-lg font-semibold tracking-tight">{t('attention')}</h2>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {canEvaluate && (
              <QueueTile
                href="/evaluate"
                label={t('toEvaluate')}
                count={toEvaluate.length}
                icon={ClipboardCheckIcon}
              />
            )}
            {canVerify && (
              <QueueTile
                href="/verify"
                label={t('toVerify')}
                count={toVerify.length}
                icon={FileCheck2Icon}
              />
            )}
            {canRelease && (
              <QueueTile
                href="/verify"
                label={t('toRelease')}
                count={toRelease.length}
                icon={SendIcon}
              />
            )}
            {canApprove && (
              <QueueTile
                href="/approvals"
                label={t('toApprove')}
                count={pending.length}
                icon={UserRoundCheckIcon}
              />
            )}
          </div>

          {totalWaiting === 0 ? (
            <Card>
              <CardContent className="p-0">
                <EmptyState
                  icon={CheckCircle2Icon}
                  message={t('attentionEmpty')}
                  hint={t('attentionEmptyHint')}
                />
              </CardContent>
            </Card>
          ) : (
            worklist.length > 0 && (
              <Card>
                <CardContent className="p-0">
                  <ul className="divide-y">
                    {worklist.map(({ item, kind }) => (
                      <li key={`${kind}-${item.attempt_id}`}>
                        <Link
                          href={kind === 'evaluate' ? `/evaluate/${item.attempt_id}` : '/verify'}
                          // min-h-11 is the 44px touch target this is read at.
                          className="flex min-h-11 items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none"
                        >
                          <span
                            aria-hidden
                            className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-xs font-semibold"
                          >
                            {initials(item.candidate_name)}
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate font-medium">
                              {item.candidate_name || item.exam_title}
                            </span>
                            <span className="block truncate text-xs text-muted-foreground">
                              {item.exam_title}
                              {item.submitted_at
                                ? ` · ${t('waitingSince', {
                                    when: format.relativeTime(new Date(item.submitted_at)),
                                  })}`
                                : ` · ${t('notSubmitted')}`}
                            </span>
                          </span>
                          {/* Status is never colour alone — the badge carries a
                              word, so it survives greyscale and colour-vision
                              deficiency. */}
                          <Badge
                            variant={
                              kind === 'evaluate' ? 'warning' : kind === 'verify' ? 'info' : 'success'
                            }
                            className="shrink-0"
                          >
                            {kind === 'evaluate'
                              ? t('kindEvaluate')
                              : kind === 'verify'
                                ? t('kindVerify')
                                : t('kindRelease')}
                          </Badge>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            )
          )}
        </section>
      )}

      {/* ── The candidate's own lane ────────────────────────────────────── */}
      {openExams.length > 0 && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-heading text-lg font-semibold tracking-tight">{t('myExams')}</h2>
            <Link
              href="/my-exams"
              className={buttonVariants({ variant: 'ghost', size: 'sm' })}
            >
              {t('viewAll')}
            </Link>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            {openExams.map((exam) => (
              <Card key={exam.id} className="flex flex-col">
                <CardHeader>
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-base">{exam.title}</CardTitle>
                    {exam.open_attempt_id && (
                      <Badge variant="info" className="shrink-0">
                        {ts('inProgress')}
                      </Badge>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="flex flex-1 flex-col justify-between gap-3">
                  <dl className="flex flex-wrap gap-x-3 text-sm text-muted-foreground">
                    <dd>{ts('minutes', { count: exam.duration_minutes })}</dd>
                    {exam.question_count != null && (
                      <dd>{ts('questionCount', { count: exam.question_count })}</dd>
                    )}
                    {exam.closes_at && (
                      <dd className="w-full">
                        {ts('closes', {
                          date: format.dateTime(new Date(exam.closes_at), {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          }),
                        })}
                      </dd>
                    )}
                  </dl>
                  {/* Links to /my-exams rather than starting the attempt here.
                      Starting an exam is a one-way door behind a confirmation
                      dialog, and there must be exactly one place that owns it —
                      a second copy on the dashboard is a second thing to keep
                      in step with the attempts-remaining and window rules. */}
                  <Link href="/my-exams" className={buttonVariants({ className: 'w-full' })}>
                    {exam.open_attempt_id ? ts('resume') : ts('start')}
                  </Link>
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      )}

      {/* ── Their own performance ───────────────────────────────────────── */}
      {hasOwnStats && (
        <section className="space-y-4">
          <h2 className="font-heading text-lg font-semibold tracking-tight">{t('performance')}</h2>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatTile
              label={tr('attempts')}
              value={String(myStats!.attempts_n)}
              icon={ListChecksIcon}
            />
            <StatTile
              label={tr('passed')}
              icon={CheckCircle2Icon}
              value={tr('ofAttempts', {
                passed: myStats!.passed_n,
                total: myStats!.attempts_n,
              })}
            />
            {/* NULL is not zero. candidate_stats() returns null for somebody
                with nothing to average, and "0%" is the claim that they failed
                everything — a different and far more alarming statement. */}
            <StatTile
              label={tr('average')}
              icon={GaugeIcon}
              value={
                myStats!.avg_percent != null
                  ? tr('percentValue', { value: myStats!.avg_percent })
                  : '—'
              }
            />
            <StatTile
              label={tr('best')}
              icon={AwardIcon}
              value={
                myStats!.best_percent != null
                  ? tr('percentValue', { value: myStats!.best_percent })
                  : '—'
              }
            />
          </div>
        </section>
      )}

      {/* ── Recent results ──────────────────────────────────────────────── */}
      {recentResults.length > 0 && (
        <section className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-heading text-lg font-semibold tracking-tight">{t('myResults')}</h2>
            <Link href="/results" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
              {t('viewAll')}
            </Link>
          </div>

          <Card>
            <CardContent className="p-0">
              <ul className="divide-y">
                {recentResults.map((result) => (
                  <li key={result.attempt_id}>
                    <Link
                      href={result.published ? `/results/${result.attempt_id}` : '/results'}
                      className="flex min-h-11 items-center gap-3 px-4 py-3 transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:outline-none"
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{result.exam_title}</span>
                        <span className="block truncate text-xs text-muted-foreground">
                          {result.submitted_at
                            ? format.dateTime(new Date(result.submitted_at), {
                                dateStyle: 'medium',
                              })
                            : null}
                        </span>
                      </span>
                      {/* An unreleased result carries no verdict, because the
                          database will not give one out before publication. */}
                      {/* Both halves come from `sitting`, not one from
                          `reports`. reports.passed exists and reports.failed
                          does NOT, so the fail branch rendered the literal
                          string "reports.failed" at the person who had just
                          failed — use-intl's default fallback is the joined key
                          path, which contains neither "MISSING_MESSAGE" nor
                          "IntlError", so it slipped past the sweep for those.
                          Taking the pair from one namespace is what stops the
                          two sides drifting apart again. */}
                      {result.published ? (
                        <Badge
                          variant={result.passed ? 'success' : 'destructive'}
                          className="shrink-0"
                        >
                          {result.passed ? ts('passed') : ts('failed')}
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="shrink-0">
                          {t('resultPending')}
                        </Badge>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </section>
      )}
    </div>
  )
}

/** First letters of the first two words. Falls back to a dash, never to blank. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '—'
  return parts
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('')
}

/**
 * A count that is also the way to act on it.
 *
 * The whole tile is the link rather than a "view" affordance in the corner:
 * on a phone the number IS the button, and a 44px target inside a card is
 * worse than a card-sized one.
 */
function QueueTile({
  href,
  label,
  count,
  icon,
}: {
  href: string
  label: string
  count: number
  icon: React.ComponentProps<typeof StatTile>['icon']
}) {
  return (
    <Link
      href={href}
      // `ring-ring/50` alone measures ~2.1:1 against the page — under the 3:1
      // that WCAG 2.4.11 asks of a focus indicator. buttonVariants gets away
      // with the half-opacity ring because it pairs it with a solid
      // `focus-visible:border-ring`; a bare Link has no border to change, so
      // the ring itself has to carry full strength, with an offset so it is
      // not sitting on the card's own edge.
      className="block rounded-xl transition-transform focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background focus-visible:outline-none active:translate-y-px"
    >
      <StatTile
        label={label}
        value={String(count)}
        icon={icon}
        className="h-full transition-colors hover:bg-accent/40"
      />
    </Link>
  )
}
