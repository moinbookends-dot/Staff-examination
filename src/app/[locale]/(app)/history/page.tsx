import { getTranslations } from 'next-intl/server'
import { requirePermission } from '@/lib/auth/guards'
import { PageHeader } from '@/components/ui/page-header'
import { HistoryList } from '@/components/papers/history-list'
import { loadPaperHistory } from '@/server/papers/availability'
import type { Difficulty } from '@/lib/bank/vocabulary'
import type { PaperHistoryEntry } from '@/lib/papers/repository'

/**
 * /history — every paper ever generated.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ HISTORY IS APPEND-ONLY AND NOTHING ON THIS SCREEN CAN REMOVE A ROW.       │
 * │                                                                           │
 * │ There is no delete action, no bulk selection and no "clear history"       │
 * │ control, because the never-twice rule is enforced against these rows: a   │
 * │ paper that disappeared from history could be issued a second time.        │
 * │                                                                           │
 * │ The only thing that changes what is generatable is the Super Admin's      │
 * │ epoch reset, which does not delete anything either — it raises a counter  │
 * │ so the uniqueness index starts a fresh generation.                        │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export default async function HistoryPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requirePermission('papers.read_history')

  const t = await getTranslations('papers')
  const raw = await searchParams

  // Unparseable values fall back rather than erroring: these arrive from URLs
  // people edit, bookmark and truncate.
  const single = (key: string) => {
    const v = raw[key]
    return Array.isArray(v) ? v[0] : v
  }
  const page = Math.max(1, Number(single('page') ?? '1') || 1)

  const history = await loadPaperHistory(page, 25)

  const difficultyLabels: Record<Difficulty, string> = {
    easy: t('difficulty.easy'),
    medium: t('difficulty.medium'),
    hard: t('difficulty.hard'),
  }

  return (
    <div className="space-y-6">
      <PageHeader title={t('historyTitle')} description={t('historySubtitle')} />

      <HistoryList
        rows={history.rows as PaperHistoryEntry[]}
        difficultyLabels={difficultyLabels}
      />
    </div>
  )
}
