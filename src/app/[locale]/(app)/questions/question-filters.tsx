'use client'

import { useState, useTransition } from 'react'
import { useSearchParams } from 'next/navigation'
import { useRouter } from '@/lib/i18n/navigation'
import { useTranslations } from 'next-intl'
import { QUESTION_TYPES } from '@/lib/questions/schemas'
import { QUESTION_STATUSES } from '@/lib/questions/status'
import { filtersToSearchParams } from '@/lib/search-params'
import type { CategoryOption } from '@/server/actions/questions'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { SearchIcon, XIcon } from 'lucide-react'

/**
 * Filter bar. Writes to the URL, never to local state.
 *
 * The page reads searchParams and re-queries on the server, so the filtered
 * list is shareable, survives a refresh, and does not require holding the whole
 * bank in the browser. The only local state here is the search box, because
 * pushing a route on every keystroke would fire a query per character.
 */
export function QuestionFilters({ categories }: { categories: CategoryOption[] }) {
  const router = useRouter()
  const params = useSearchParams()
  const t = useTranslations('questions')
  const tTypes = useTranslations('questions.types')
  const [pending, startTransition] = useTransition()
  const [query, setQuery] = useState(params.get('q') ?? '')

  function apply(patch: Record<string, string>) {
    const current = Object.fromEntries(params.entries())
    // Any filter change returns to page 1: staying on page 4 of a result set
    // that now has two pages shows an empty table and looks like a bug.
    const next = { ...current, ...patch, page: '1' }
    startTransition(() => {
      router.push(`/questions?${filtersToSearchParams(next)}`)
    })
  }

  const hasFilters = ['q', 'status', 'type', 'categoryId', 'difficulty'].some((key) =>
    params.get(key),
  )

  const selectClass =
    'h-9 rounded-md border border-input bg-transparent px-2 text-sm disabled:opacity-50'

  return (
    <div className="flex flex-wrap items-center gap-2">
      <form
        className="flex min-w-56 flex-1 gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          apply({ q: query })
        }}
      >
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('searchPlaceholder')}
          disabled={pending}
          aria-label={t('searchPlaceholder')}
        />
        <Button type="submit" variant="outline" size="icon" disabled={pending} aria-label={t('search')}>
          <SearchIcon />
        </Button>
      </form>

      <select
        value={params.get('status') ?? ''}
        onChange={(e) => apply({ status: e.target.value })}
        disabled={pending}
        aria-label={t('columns.status')}
        className={selectClass}
      >
        <option value="">{t('filters.anyStatus')}</option>
        {/* Generated from QUESTION_STATUSES, not listed by hand. The hand-written
            list had three of the seven the database has, so four statuses were
            unfilterable — and a URL naming one of them fell through to the
            unfiltered first page. */}
        {QUESTION_STATUSES.map((status) => (
          <option key={status} value={status}>
            {t(`status.${status}`)}
          </option>
        ))}
      </select>

      <select
        value={params.get('type') ?? ''}
        onChange={(e) => apply({ type: e.target.value })}
        disabled={pending}
        aria-label={t('columns.type')}
        className={selectClass}
      >
        <option value="">{t('filters.anyType')}</option>
        {QUESTION_TYPES.map((type) => (
          <option key={type} value={type}>
            {tTypes(type)}
          </option>
        ))}
      </select>

      <select
        value={params.get('categoryId') ?? ''}
        onChange={(e) => apply({ categoryId: e.target.value })}
        disabled={pending}
        aria-label={t('columns.category')}
        className={selectClass}
      >
        <option value="">{t('filters.anyCategory')}</option>
        {categories.map((category) => (
          <option key={category.id} value={category.id}>
            {category.parent_id ? '— ' : ''}
            {category.name}
          </option>
        ))}
      </select>

      <select
        value={params.get('difficulty') ?? ''}
        onChange={(e) => apply({ difficulty: e.target.value })}
        disabled={pending}
        aria-label={t('columns.difficulty')}
        className={selectClass}
      >
        <option value="">{t('filters.anyDifficulty')}</option>
        {[1, 2, 3, 4, 5].map((value) => (
          <option key={value} value={String(value)}>
            {value}
          </option>
        ))}
      </select>

      {hasFilters && (
        <Button
          variant="ghost"
          size="sm"
          disabled={pending}
          onClick={() => {
            setQuery('')
            startTransition(() => router.push('/questions'))
          }}
        >
          <XIcon />
          {t('filters.clear')}
        </Button>
      )}
    </div>
  )
}
