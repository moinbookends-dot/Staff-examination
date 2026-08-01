import { getTranslations } from 'next-intl/server'
import { requirePermission } from '@/lib/auth/guards'
import { can } from '@/lib/auth/claims'
import { Link } from '@/lib/i18n/navigation'
import { listQuestions, listCategories } from '@/server/actions/questions'
import { listSavedFilters } from '@/server/actions/saved-filters'
import { parseQuestionFilters } from '@/lib/questions/filters'
import { filtersToSearchParams } from '@/lib/search-params'
import { QUESTION_URL_DEFAULTS } from '@/lib/questions/sort'
import { QuestionFilters } from './question-filters'
import { QuestionSelectionProvider } from '@/components/questions/selection-provider'
import { QuestionTable } from '@/components/questions/question-table'
import { BulkToolbar } from '@/components/questions/bulk-toolbar'
import { SavedFilterMenu } from '@/components/questions/saved-filter-menu'
import { Button, buttonVariants } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ActivityIcon, PlusIcon, Trash2Icon } from 'lucide-react'

/**
 * The question bank — the screen the whole of M8 exists to serve.
 *
 * FILTERS LIVE IN THE URL, not in component state. A chef can bookmark "active
 * knife-skills questions at difficulty 4" and send it to another chef; state
 * would make that unshareable and lose the filter on every back-navigation.
 * Sorting, page size and the recycle-bin flag joined them for the same reason,
 * and are validated by the same schema.
 *
 * It is also the shape M3's exam builder needs: rule-based selection is a saved
 * filter, chosen over pool membership tables because membership goes stale —
 * a question added next week belongs to no pool until somebody remembers.
 *
 * This file composes and does not decide. Every permission below is a courtesy
 * that hides a control which would fail anyway: the actions re-check each one
 * and the RPCs behind them are SECURITY INVOKER, so RLS is the boundary.
 */
export default async function QuestionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const claims = await requirePermission('questions.read')
  const t = await getTranslations('questions')

  const raw = await searchParams
  // Unparseable parameters fall back to defaults rather than erroring: these
  // arrive from URLs people edit, share and truncate.
  const filters = parseQuestionFilters(raw)

  const canUpdate = can(claims, 'questions.update')
  const canRetire = can(claims, 'questions.retire')

  const [{ items, total, page, pageSize }, categories, savedFilters] = await Promise.all([
    listQuestions(filters),
    listCategories(),
    listSavedFilters(),
  ])

  const lastPage = Math.max(1, Math.ceil(total / pageSize))
  const href = (patch: Record<string, string | number | boolean>) =>
    `/questions?${filtersToSearchParams({ ...filters, ...patch }, QUESTION_URL_DEFAULTS)}`

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {filters.deleted ? t('bin.title') : t('title')}
          </h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!filters.deleted && (
            <Link
              href="/questions/quality"
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              <ActivityIcon />
              {t('quality.title')}
            </Link>
          )}
          {/* Only offered to whoever can act on it. 0041's questions_read_deleted
              requires questions.retire, so without it the view is empty anyway —
              a link to an empty page is worse than no link. */}
          {canRetire && (
            <Link
              href={filters.deleted ? '/questions' : href({ deleted: true, page: 1 })}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              <Trash2Icon />
              {filters.deleted ? t('bin.leave') : t('bin.open')}
            </Link>
          )}
          {/* buttonVariants on a Link, not <Button asChild> — Base UI's Button
              has no asChild, and a real anchor keeps middle-click and
              open-in-new-tab working. */}
          {can(claims, 'questions.create') && !filters.deleted && (
            <Link href="/questions/new" className={buttonVariants()}>
              <PlusIcon />
              {t('new')}
            </Link>
          )}
        </div>
      </div>

      {!filters.deleted && (
        <>
          <QuestionFilters categories={categories} />
          <SavedFilterMenu filters={savedFilters} />
        </>
      )}

      {/*
       * The provider wraps the toolbar AND the table, because the toolbar shows
       * what the table selected. It is above both so a soft navigation — every
       * filter, sort and page change is one — cannot remount the selection away.
       */}
      <QuestionSelectionProvider>
        {(canUpdate || canRetire) && (
          <BulkToolbar canUpdate={canUpdate} canRetire={canRetire} inBin={filters.deleted} />
        )}

        {items.length === 0 ? (
          <EmptyState message={filters.deleted ? t('bin.empty') : t('empty')} />
        ) : (
          <QuestionTable items={items} canSelect={canUpdate || canRetire} />
        )}
      </QuestionSelectionProvider>

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
        <span className="text-muted-foreground">{t('pagination', { page, lastPage, total })}</span>

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-1.5 text-muted-foreground">
            {t('pageSize.label')}
            {/*
             * Links, not a <select> with an onChange — this is a server
             * component, and a real anchor keeps the choice shareable and
             * needs no JavaScript to work.
             */}
            <span className="flex gap-1">
              {[25, 50, 100].map((size) => (
                <Link
                  key={size}
                  href={href({ pageSize: size, page: 1 })}
                  aria-current={pageSize === size ? 'true' : undefined}
                  className={
                    pageSize === size
                      ? 'rounded px-1.5 font-medium text-foreground underline underline-offset-4'
                      : 'rounded px-1.5 hover:text-foreground'
                  }
                >
                  {size}
                </Link>
              ))}
            </span>
          </label>

          {lastPage > 1 && (
            /* At the ends of the range the control becomes a disabled button
               rather than a dead link. An anchor cannot be disabled — styling
               one to look inert still leaves it clickable, focusable and in
               the tab order. */
            <div className="flex gap-2">
              {page > 1 ? (
                <Link
                  href={href({ page: page - 1 })}
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                >
                  {t('previous')}
                </Link>
              ) : (
                <Button variant="outline" size="sm" disabled>
                  {t('previous')}
                </Button>
              )}
              {page < lastPage ? (
                <Link
                  href={href({ page: page + 1 })}
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                >
                  {t('next')}
                </Link>
              ) : (
                <Button variant="outline" size="sm" disabled>
                  {t('next')}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
