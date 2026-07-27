import { getTranslations, getFormatter } from 'next-intl/server'
import { requirePermission } from '@/lib/auth/guards'
import { can } from '@/lib/auth/claims'
import { Link } from '@/lib/i18n/navigation'
import { listExams } from '@/server/actions/exams'
import { examFiltersSchema } from '@/lib/exams/filters'
import { filtersToSearchParams } from '@/lib/search-params'
import { ExamFilters } from './exam-filters'
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
 * The exam list.
 *
 * Same URL-state pattern as the question bank: filters live in searchParams so a
 * chef can bookmark "scheduled monthly exams" and send the link on.
 *
 * The columns are chosen for the question a chef actually arrives with — "is
 * this ready, and when does it run?" — so status, the window and the paper size
 * lead, and anything derivable from those is left out.
 */
export default async function ExamsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const claims = await requirePermission('exams.read')
  const t = await getTranslations('exams')
  const format = await getFormatter()

  const raw = await searchParams
  const parsed = examFiltersSchema.safeParse(raw)
  const filters = parsed.success ? parsed.data : { page: 1 }

  const { items, total, page, pageSize } = await listExams(filters)
  const lastPage = Math.max(1, Math.ceil(total / pageSize))
  const pageHref = (target: number) =>
    `/exams?${filtersToSearchParams({ ...filters, page: target })}`

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        {can(claims, 'exams.create') && (
          <Link href="/exams/new" className={buttonVariants()}>
            <PlusIcon />
            {t('new')}
          </Link>
        )}
      </div>

      <ExamFilters />

      <Card>
        <CardContent>
          {items.length === 0 ? (
            <p className="py-10 text-center text-sm text-muted-foreground">{t('empty')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.exam')}</TableHead>
                  <TableHead>{t('columns.kind')}</TableHead>
                  <TableHead>{t('columns.status')}</TableHead>
                  <TableHead className="text-right">{t('columns.questions')}</TableHead>
                  <TableHead className="text-right">{t('columns.marks')}</TableHead>
                  <TableHead className="text-right">{t('columns.duration')}</TableHead>
                  <TableHead>{t('columns.window')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((exam) => (
                  <TableRow key={exam.id}>
                    <TableCell className="max-w-md">
                      <Link
                        href={`/exams/${exam.id}`}
                        className="font-medium underline-offset-4 hover:underline"
                      >
                        {exam.title}
                      </Link>
                      <div className="flex gap-2 text-xs text-muted-foreground">
                        {/* Surfaced in the list because it changes what a
                            candidate experiences and is invisible otherwise:
                            a per-attempt exam has no single paper to inspect. */}
                        <span>{t(`paperMode.${exam.paper_mode}`)}</span>
                        {exam.requires_manual_grading && <span>· {t('manualGrading')}</span>}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {t(`kinds.${exam.kind}`)}
                    </TableCell>
                    <TableCell>
                      <Badge variant={exam.status === 'active' ? 'default' : 'secondary'}>
                        {t(`status.${exam.status}`)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right text-sm">
                      {exam.question_count ?? '—'}
                    </TableCell>
                    <TableCell className="text-right text-sm">{exam.total_marks ?? '—'}</TableCell>
                    <TableCell className="text-right text-sm">
                      {t('minutes', { count: exam.duration_minutes })}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {exam.opens_at
                        ? format.dateTime(new Date(exam.opens_at), {
                            day: 'numeric',
                            month: 'short',
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : t('noWindow')}
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
          <div className="flex gap-2">
            {page > 1 ? (
              <Link
                href={pageHref(page - 1)}
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
                href={pageHref(page + 1)}
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
        </div>
      )}
    </div>
  )
}
