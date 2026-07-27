'use client'

import { useTransition } from 'react'
import { useSearchParams } from 'next/navigation'
import { useRouter } from '@/lib/i18n/navigation'
import { useTranslations } from 'next-intl'
import { EXAM_KINDS } from '@/lib/exams/rules'
import { filtersToSearchParams } from '@/lib/search-params'
import { Button } from '@/components/ui/button'
import { XIcon } from 'lucide-react'

const STATUSES = ['draft', 'scheduled', 'active', 'completed', 'archived', 'cancelled'] as const

/**
 * Filter bar for the exam list. Writes to the URL, never to local state.
 *
 * No search box, unlike the question bank: an outlet runs tens of exams, not
 * thousands of questions, so status and kind narrow it far enough and a
 * full-text index would be answering a question nobody has.
 */
export function ExamFilters() {
  const router = useRouter()
  const params = useSearchParams()
  const t = useTranslations('exams')
  const [pending, startTransition] = useTransition()

  function apply(patch: Record<string, string>) {
    const current = Object.fromEntries(params.entries())
    // Any filter change returns to page 1: staying on page 4 of a result set
    // that now has two shows an empty table and reads as a bug.
    const next = { ...current, ...patch, page: '1' }
    startTransition(() => {
      router.push(`/exams?${filtersToSearchParams(next)}`)
    })
  }

  const hasFilters = ['status', 'kind'].some((key) => params.get(key))
  const selectClass =
    'h-9 rounded-md border border-input bg-transparent px-2 text-sm disabled:opacity-50'

  return (
    <div className="flex flex-wrap items-center gap-2">
      <select
        value={params.get('status') ?? ''}
        onChange={(e) => apply({ status: e.target.value })}
        disabled={pending}
        aria-label={t('columns.status')}
        className={selectClass}
      >
        <option value="">{t('filters.anyStatus')}</option>
        {STATUSES.map((status) => (
          <option key={status} value={status}>
            {t(`status.${status}`)}
          </option>
        ))}
      </select>

      <select
        value={params.get('kind') ?? ''}
        onChange={(e) => apply({ kind: e.target.value })}
        disabled={pending}
        aria-label={t('columns.kind')}
        className={selectClass}
      >
        <option value="">{t('filters.anyKind')}</option>
        {EXAM_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {t(`kinds.${kind}`)}
          </option>
        ))}
      </select>

      {hasFilters && (
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => startTransition(() => router.push('/exams'))}
        >
          <XIcon />
          {t('filters.clear')}
        </Button>
      )}
    </div>
  )
}
