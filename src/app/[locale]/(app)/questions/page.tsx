import { getTranslations } from 'next-intl/server'
import { requirePermission } from '@/lib/auth/guards'
import { can } from '@/lib/auth/claims'
import { Link } from '@/lib/i18n/navigation'
import { listQuestions, listCategories } from '@/server/actions/questions'
import { parseQuestionFilters } from '@/lib/questions/filters'
import { filtersToSearchParams } from '@/lib/search-params'
import { QuestionFilters } from './question-filters'
import { Button, buttonVariants } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { PlusIcon } from 'lucide-react'

/**
 * The question bank.
 *
 * FILTERS LIVE IN THE URL, not in component state. A chef can bookmark "active
 * knife-skills questions at difficulty 4" and send it to another chef; state
 * would make that unshareable and lose the filter on every back-navigation.
 *
 * It is also the shape M3's exam builder needs: rule-based selection is a saved
 * filter, chosen over pool membership tables because membership goes stale —
 * a question added next week belongs to no pool until somebody remembers.
 */
export default async function QuestionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const claims = await requirePermission('questions.read')
  const t = await getTranslations('questions')
  const tTypes = await getTranslations('questions.types')
  const tBloom = await getTranslations('questions.bloom')
  const tSource = await getTranslations('questions.source')

  const raw = await searchParams
  // Unparseable parameters fall back to defaults rather than erroring: these
  // arrive from URLs people edit, share and truncate.
  const filters = parseQuestionFilters(raw)

  const [{ items, total, page, pageSize }, categories] = await Promise.all([
    listQuestions(filters),
    listCategories(),
  ])

  const lastPage = Math.max(1, Math.ceil(total / pageSize))
  const pageHref = (target: number) =>
    `/questions?${filtersToSearchParams({ ...filters, page: target })}`

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        {/* buttonVariants on a Link, not <Button asChild> — Base UI's Button
            has no asChild, and a real anchor keeps middle-click and
            open-in-new-tab working. */}
        {can(claims, 'questions.create') && (
          <Link href="/questions/new" className={buttonVariants()}>
            <PlusIcon />
            {t('new')}
          </Link>
        )}
      </div>

      <QuestionFilters categories={categories} />

      <Card>
        <CardContent>
          {items.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">{t('empty')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.question')}</TableHead>
                  <TableHead>{t('columns.type')}</TableHead>
                  <TableHead>{t('columns.category')}</TableHead>
                  <TableHead className="text-right">{t('columns.difficulty')}</TableHead>
                  <TableHead>{t('columns.bloom')}</TableHead>
                  <TableHead>{t('columns.source')}</TableHead>
                  <TableHead className="text-right">{t('columns.marks')}</TableHead>
                  <TableHead>{t('columns.status')}</TableHead>
                  <TableHead className="text-right">{t('columns.revision')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.id}>
                    <TableCell className="max-w-md">
                      <Link
                        href={`/questions/${item.id}`}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {item.stem}
                      </Link>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {tTypes(item.type)}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {item.category_name ?? '—'}
                    </TableCell>
                    <TableCell className="text-right text-sm">{item.difficulty}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {item.bloom_level ? tBloom(item.bloom_level) : '—'}
                    </TableCell>
                    <TableCell className="text-sm">
                      {/* Provenance at a glance. 'manual' is the overwhelming
                          majority and carries no badge — badging every row
                          makes the exceptions harder to see, not easier. */}
                      {item.source === 'manual' ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <Badge variant={item.source === 'ai' ? 'info' : 'secondary'}>
                          {tSource(item.source)}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-sm">{item.marks}</TableCell>
                    <TableCell>
                      <Badge variant={item.status === 'active' ? 'default' : 'secondary'}>
                        {t(`status.${item.status}`)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right text-sm text-muted-foreground">
                      {item.revision}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {lastPage > 1 && (
        <div className="flex items-center justify-between text-sm">
          <span className="text-muted-foreground">
            {t('pagination', { page, lastPage, total })}
          </span>
          {/* At the ends of the range the control becomes a disabled button
              rather than a dead link. An anchor cannot be disabled — styling one
              to look inert still leaves it clickable, focusable and in the tab
              order. */}
          <div className="flex gap-2">
            {page > 1 ? (
              <Link href={pageHref(page - 1)} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                {t('previous')}
              </Link>
            ) : (
              <Button variant="outline" size="sm" disabled>
                {t('previous')}
              </Button>
            )}
            {page < lastPage ? (
              <Link href={pageHref(page + 1)} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                {t('next')}
              </Link>
            ) : (
              <Button variant="outline" size="sm" disabled>
                {t('next')}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
