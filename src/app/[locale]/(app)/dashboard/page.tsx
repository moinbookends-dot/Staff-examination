import { getTranslations } from 'next-intl/server'
import {
  ArchiveIcon,
  CheckCircle2Icon,
  FilePenLineIcon,
  FileTextIcon,
  LayersIcon,
  SparklesIcon,
  UsersIcon,
} from 'lucide-react'
import { requireApproved } from '@/lib/auth/guards'
import { getAppClaims } from '@/lib/auth/claims'
import { canGeneratePapers, canOpenQuestionBank, canReadPaperHistory } from '@/lib/auth/bank-access'
import { Link } from '@/lib/i18n/navigation'
import { PageHeader } from '@/components/ui/page-header'
import { buttonVariants } from '@/components/ui/button'
import { DistributionBar, StatCard } from '@/components/papers/stat-card'
import { loadBankStatistics, loadPaperHistory } from '@/server/papers/availability'
import { DIFFICULTIES } from '@/lib/bank/vocabulary'
import { cn } from '@/lib/utils'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Dashboard, per the Stitch design.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THIS REPLACES THE LEGACY DASHBOARD ENTIRELY.                              ║
 * ║                                                                           ║
 * ║ The previous page was built for the online delivery product: evaluation   ║
 * ║ and verification queues, attempts in progress, released results, and      ║
 * ║ candidate statistics. Every one of those subsystems is being removed.     ║
 * ║                                                                           ║
 * ║ It also linked to /evaluate, /verify and /reports from its own body —     ║
 * ║ routes deliberately taken out of the navigation — so a chef could still   ║
 * ║ reach them by clicking a tile. scripts/check-shell.mjs was failing four   ║
 * ║ assertions on exactly that, and those failures were correct.              ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ EVERY TILE AND EVERY QUICK ACTION IS PERMISSION-GATED.                    │
 * │                                                                           │
 * │ The predicates are evaluated HERE, in a Server Component, and only        │
 * │ booleans and numbers reach the markup. A dashboard is the easiest place   │
 * │ to leak a route somebody may not follow, because a tile does not look     │
 * │ like navigation.                                                          │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */
export default async function DashboardPage() {
  await requireApproved()

  const claims = await getAppClaims()
  const t = await getTranslations('papers')

  const canBank = canOpenQuestionBank(claims)
  const canGenerate = canGeneratePapers(claims)
  const canHistory = canReadPaperHistory(claims)

  /*
   * The bank statistics are only fetched for somebody who may see the bank.
   * A chef's dashboard is about papers, and reading counts they have no screen
   * for would be a query run to render nothing.
   */
  const [stats, history] = await Promise.all([
    loadBankStatistics(),
    canHistory ? loadPaperHistory(1, 5) : Promise.resolve({ rows: [], total: 0, page: 1, pageSize: 5 }),
  ])

  const difficultyLabels = {
    easy: t('difficulty.easy'),
    medium: t('difficulty.medium'),
    hard: t('difficulty.hard'),
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('dashTitle')}
        description={t('dashSubtitle')}
        actions={
          <div className="flex flex-wrap gap-2">
            {canGenerate && (
              <Link href="/papers/generate" className={cn(buttonVariants({ size: 'sm' }))}>
                <SparklesIcon />
                {t('generateTitle')}
              </Link>
            )}
            {canBank && (
              <Link
                href="/questions"
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
              >
                <LayersIcon />
                {t('statTotal')}
              </Link>
            )}
            {canHistory && (
              <Link
                href="/history"
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
              >
                <FileTextIcon />
                {t('historyTitle')}
              </Link>
            )}
          </div>
        }
      />

      {/* ── Bank statistics — Editors only ──────────────────────────────── */}
      {canBank && (
        <>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <StatCard
              label={t('statTotal')}
              value={stats.total.toLocaleString()}
              icon={<LayersIcon className="size-5" />}
              tone="primary"
            />
            <StatCard
              label={t('statActive')}
              value={stats.active.toLocaleString()}
              hint={t('statActiveHint')}
              icon={<CheckCircle2Icon className="size-5" />}
            />
            <StatCard
              label={t('statDraft')}
              value={stats.draft.toLocaleString()}
              hint={t('statDraftHint')}
              icon={<FilePenLineIcon className="size-5" />}
            />
            <StatCard
              label={t('statArchived')}
              value={stats.archived.toLocaleString()}
              hint={t('statArchivedHint')}
              icon={<ArchiveIcon className="size-5" />}
            />
          </div>

          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
            <section className="rounded-xl border bg-card p-5">
              <h2 className="text-title-md">{t('distributionTitle')}</h2>
              <div className="mt-4 space-y-4">
                {DIFFICULTIES.map((d) => (
                  <DistributionBar
                    key={d}
                    label={difficultyLabels[d]}
                    count={stats.byDifficulty[d]}
                    total={stats.total}
                  />
                ))}
              </div>
            </section>

            <RecentPapers rows={history.rows} canHistory={canHistory} />
          </div>
        </>
      )}

      {/* ── A chef sees papers only ─────────────────────────────────────── */}
      {!canBank && (
        <>
          <div className="grid gap-4 sm:grid-cols-2">
            <StatCard
              label={t('statPapers')}
              value={stats.papersGenerated.toLocaleString()}
              icon={<FileTextIcon className="size-5" />}
              tone="primary"
            />
            <StatCard
              label={t('statEditors')}
              value={stats.editors.toLocaleString()}
              icon={<UsersIcon className="size-5" />}
            />
          </div>
          <RecentPapers rows={history.rows} canHistory={canHistory} />
        </>
      )}
    </div>
  )
}

async function RecentPapers({
  rows,
  canHistory,
}: {
  rows: { id: string; paperNo: number }[]
  canHistory: boolean
}) {
  const t = await getTranslations('papers')

  if (!canHistory) return null

  return (
    <section className="rounded-xl border bg-card p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-title-md">{t('recentPapers')}</h2>
        <Link href="/history" className="text-body-sm text-primary hover:underline">
          {t('viewAll')}
        </Link>
      </div>

      {rows.length === 0 ? (
        // The honest state while nothing has been generated. No skeleton: the
        // data is loaded, and it is genuinely empty.
        <p className="mt-6 text-body-sm text-muted-foreground">{t('noActivity')}</p>
      ) : (
        <ul className="mt-4 divide-y">
          {rows.map((row) => (
            <li key={row.id} className="py-3 first:pt-0 last:pb-0">
              <Link href={`/history/${row.id}`} className="text-body-sm hover:underline">
                {t('paperNo', { paperNo: row.paperNo })}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
