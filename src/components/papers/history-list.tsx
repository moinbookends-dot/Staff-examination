import { getTranslations, getFormatter } from 'next-intl/server'
import { DownloadIcon, EyeIcon, FileTextIcon } from 'lucide-react'
import { Link } from '@/lib/i18n/navigation'
import { Badge } from '@/components/ui/badge'
import { PaperStatusBadge } from '@/components/papers/paper-status'
import { buttonVariants } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import type { Difficulty } from '@/lib/bank/vocabulary'
import type { PaperHistoryEntry } from '@/lib/papers/repository'
import { cn } from '@/lib/utils'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Exam History, per the Stitch designs.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ ONE COMPONENT, TWO LAYOUTS — NOT A TABLE THAT SCROLLS SIDEWAYS.           ║
 * ║                                                                           ║
 * ║ The desktop design is a table; the mobile design is a stack of cards.     ║
 * ║ Both are rendered and one is hidden per breakpoint, because a table with  ║
 * ║ eight columns on a 375px screen either scrolls horizontally — which the   ║
 * ║ brief forbids — or truncates every cell to uselessness.                   ║
 * ║                                                                           ║
 * ║ The rows are read TWICE into markup, which costs a little HTML and buys   ║
 * ║ two layouts that are each right for their width. The alternative is a     ║
 * ║ JavaScript breakpoint hook, which cannot run in a Server Component and    ║
 * ║ would flash the wrong layout on first paint.                              ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * A Server Component: it renders links and formatted dates, and holds no
 * state. Nothing here crosses a client boundary.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface HistoryListProps {
  rows: PaperHistoryEntry[]
  difficultyLabels: Record<Difficulty, string>
  /** True when a filter is applied, so the empty state can say which kind. */
  narrowed?: boolean
}

export async function HistoryList({ rows, difficultyLabels, narrowed }: HistoryListProps) {
  const t = await getTranslations('papers')
  const format = await getFormatter()

  if (rows.length === 0) {
    return (
      <EmptyState
        // The component, not an element — EmptyState renders it itself so it
        // controls the size and the dashed frame around it.
        icon={FileTextIcon}
        message={narrowed ? t('historyEmptyFiltered') : t('historyEmpty')}
        hint={narrowed ? undefined : t('historyEmptyHint')}
      />
    )
  }

  const when = (iso: string) =>
    format.dateTime(new Date(iso), { day: 'numeric', month: 'short', year: 'numeric' })

  return (
    <>
      {/* ── Desktop: table ───────────────────────────────────────────────
          Horizontal dividers only and a label-caps header row, per DESIGN.md's
          data-table rule. */}
      <div className="hidden overflow-hidden rounded-xl border bg-card md:block">
        <table className="w-full text-body-sm">
          <thead>
            <tr className="border-b text-label-caps text-muted-foreground">
              <th className="px-4 py-3 text-left font-medium">{t('colPaper')}</th>
              <th className="px-4 py-3 text-left font-medium">{t('colDifficulty')}</th>
              <th className="px-4 py-3 text-right font-medium">{t('colMarks')}</th>
              <th className="px-4 py-3 text-right font-medium">{t('colQuestions')}</th>
              <th className="px-4 py-3 text-left font-medium">{t('colGeneratedBy')}</th>
              <th className="px-4 py-3 text-left font-medium">{t('colDate')}</th>
              <th className="px-4 py-3 text-right font-medium">{t('colActions')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id} className="border-b last:border-0 hover:bg-accent/40">
                <td className="px-4 py-3 font-medium">
                  <span className="flex flex-wrap items-center gap-2">
                    {t('paperNo', { paperNo: row.paperNo })}
                    {/* Which paper is actually in use, at a glance — otherwise
                        every row in this list looks equally current. */}
                    {row.status !== 'generated' && <PaperStatusBadge status={row.status} />}
                  </span>
                </td>
                <td className="px-4 py-3">
                  <Badge variant="outline">{difficultyLabels[row.difficulty]}</Badge>
                </td>
                <td className="px-4 py-3 text-right tabular-nums">{row.marks}</td>
                <td className="px-4 py-3 text-right tabular-nums">{row.questionCount}</td>
                <td className="px-4 py-3 text-muted-foreground">{row.generatedByName}</td>
                <td className="px-4 py-3 text-muted-foreground">{when(row.generatedAt)}</td>
                <td className="px-4 py-3">
                  <div className="flex justify-end gap-1">
                    <Link
                      href={`/history/${row.id}`}
                      aria-label={t('viewDetails')}
                      className={cn(buttonVariants({ variant: 'ghost', size: 'icon' }))}
                    >
                      <EyeIcon />
                    </Link>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* ── Mobile: cards ───────────────────────────────────────────────── */}
      <ul className="space-y-3 md:hidden">
        {rows.map((row) => (
          <li key={row.id} className="rounded-xl border bg-card p-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <span className="block truncate text-title-md">
                  {t('paperNo', { paperNo: row.paperNo })}
                </span>
                <span className="mt-0.5 block text-body-sm text-muted-foreground">
                  {row.generatedByName} · {when(row.generatedAt)}
                </span>
              </div>
              <span className="flex shrink-0 items-center gap-2">
                {row.status !== 'generated' && <PaperStatusBadge status={row.status} />}
                <Badge variant="outline">{difficultyLabels[row.difficulty]}</Badge>
              </span>
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-body-sm text-muted-foreground">
              <span>
                {t('colMarks')}: <span className="tabular-nums text-foreground">{row.marks}</span>
              </span>
              <span>
                {t('colQuestions')}:{' '}
                <span className="tabular-nums text-foreground">{row.questionCount}</span>
              </span>
            </div>

            {/* Full-width targets: these are the actions somebody taps on a
                phone, and an icon button is a 32px target next to a 44px one. */}
            <div className="mt-3 grid grid-cols-2 gap-2">
              <Link
                href={`/history/${row.id}`}
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
              >
                <EyeIcon />
                {t('viewDetails')}
              </Link>
              <Link
                href={`/history/${row.id}`}
                className={cn(buttonVariants({ variant: 'default', size: 'sm' }))}
              >
                <DownloadIcon />
                {t('downloadsFor')}
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </>
  )
}
