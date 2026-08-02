import { getTranslations, getFormatter } from 'next-intl/server'
import { requirePermission } from '@/lib/auth/guards'
import { Link } from '@/lib/i18n/navigation'
import { listSourceDocuments } from '@/server/actions/source-documents'
import {
  KIND_GROUP_NAMES,
  SOURCE_DOCUMENT_STATUSES,
  guideFiltersSchema,
  parseGuideFilters,
  type SourceDocumentStatus,
} from '@/lib/imports/source-documents'
import { filtersToSearchParams } from '@/lib/search-params'
import { cn } from '@/lib/utils'
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
import { EmptyState } from '@/components/ui/empty-state'
import { PageHeader } from '@/components/ui/page-header'
import { FileTextIcon } from 'lucide-react'

/**
 * What every link leaves out.
 *
 * `kind=all` is what the schema applies when the parameter is absent, so
 * carrying it makes the unfiltered library look filtered and gives one view two
 * addresses — the same reason filtersToSearchParams drops `page=1`.
 *
 * Read off the schema rather than written out a second time: the default lives
 * in exactly one place, so renaming or reordering the tabs cannot leave a stale
 * copy here that quietly stops eliding.
 */
const GUIDE_URL_DEFAULTS = { kind: guideFiltersSchema.parse({}).kind }

/**
 * Ingest state → pill colour.
 *
 * Keyed by SourceDocumentStatus rather than by `string`, so widening 0048's
 * status CHECK fails to compile here instead of shipping a state that renders
 * in the same grey as every other — the one thing a status column exists to
 * tell apart.
 */
const STATUS_VARIANT: Record<
  SourceDocumentStatus,
  'secondary' | 'info' | 'success' | 'destructive' | 'outline'
> = {
  uploaded: 'secondary',
  processing: 'info',
  processed: 'success',
  failed: 'destructive',
  archived: 'outline',
}

/**
 * The row's status, if this build knows the word.
 *
 * `status` arrives typed as plain `string` — the type generator reads columns,
 * not CHECK constraints — so a migration that adds a sixth state reaches this
 * page before any message key does. Rendering the raw value is honest and
 * legible; interpolating it into `t()` would raise IntlError and paint
 * `guide.status.quarantined` into the table instead.
 */
function knownStatus(status: string): SourceDocumentStatus | null {
  return (SOURCE_DOCUMENT_STATUSES as readonly string[]).includes(status)
    ? (status as SourceDocumentStatus)
    : null
}

/**
 * Guide (AI) — the source documents everything downstream is generated from.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE TABS ARE ANCHORS, NOT STATE.                                          │
 * │                                                                           │
 * │ Same rule as the question bank's filters, for the same reasons: a chef    │
 * │ can send "the question papers" to another chef, a bookmark survives, and  │
 * │ back-navigation returns to the shelf that was open rather than to `all`.  │
 * │ Client tab state would lose all three, and would additionally make this   │
 * │ page need JavaScript to show a list that is already fully rendered on the │
 * │ server.                                                                   │
 * │                                                                           │
 * │ Each tab is a KIND_GROUPS name, not a kind — "SOPs & manuals" is seven    │
 * │ kinds and could not be named by a single-kind parameter. The grouping     │
 * │ lives in src/lib/imports/source-documents.ts and this file only renders   │
 * │ it, so regrouping a shelf never touches the page.                         │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * No `can()` calls, and no actions in the header: there is nothing on this
 * screen a reader could be offered and refused. Uploading is questions.import
 * and its action does not exist yet — a button that 404s is the defect nav.ts
 * spent two milestones removing, so it arrives with the action, not before it.
 *
 * Search and status are parsed and preserved but have no control yet. They are
 * honoured from the URL today and every tab link carries them through, so the
 * filter bar, when it lands, is a component and not a rewiring.
 */
export default async function GuidePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  await requirePermission('questions.read')
  const t = await getTranslations('guide')
  const format = await getFormatter()

  const raw = await searchParams
  // Unparseable parameters fall back to defaults rather than erroring: these
  // arrive from URLs people edit, share and truncate.
  const filters = parseGuideFilters(raw)

  // ONE read, so one await. The question bank uses Promise.all because it has
  // three independent fetches and running them in series would cost two round
  // trips; Promise.all over a single promise buys nothing and reads as a
  // promise that a second fetch exists. The moment one does — per-tab counts,
  // or the OCR progress below — this becomes Promise.all.
  const { items, total, page, pageSize } = await listSourceDocuments(filters)

  const lastPage = Math.max(1, Math.ceil(total / pageSize))
  const href = (patch: Record<string, string | number | boolean>) =>
    `/guide?${filtersToSearchParams({ ...filters, ...patch }, GUIDE_URL_DEFAULTS)}`

  // Whether "nothing here" means "nothing has been uploaded" or "nothing
  // matches what you asked for". Told apart from the filters rather than from a
  // second COUNT: the two sentences want different advice, and the wrong one
  // sends somebody looking for an upload button when their library is full.
  const narrowed = filters.kind !== 'all' || Boolean(filters.q) || Boolean(filters.status)

  return (
    <div className="space-y-6">
      <PageHeader title={t('title')} description={t('subtitle')} />

      {/* A plain <nav> of links, deliberately not role="tablist": that role
          promises arrow-key navigation between tabs and panels that belong to
          them, and this is a set of destinations. aria-current="page" is what
          actually tells a screen reader which shelf is open. */}
      <nav aria-label={t('tabsLabel')} className="flex flex-wrap gap-1 border-b">
        {KIND_GROUP_NAMES.map((name) => {
          const current = filters.kind === name
          return (
            <Link
              key={name}
              // page: 1 with every tab. Arriving on page 3 of the cookbooks and
              // switching to Images would otherwise ask for page 3 of a shelf
              // with four files on it and show an empty table.
              href={href({ kind: name, page: 1 })}
              aria-current={current ? 'page' : undefined}
              className={cn(
                '-mb-px border-b-2 px-3 py-2 text-sm transition-colors',
                current
                  ? 'border-primary font-medium text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground',
              )}
            >
              {t(`tabs.${name}`)}
            </Link>
          )
        })}
      </nav>

      <Card>
        <CardContent>
          {items.length === 0 ? (
            <EmptyState
              icon={FileTextIcon}
              message={narrowed ? t('emptyFiltered') : t('empty')}
              hint={narrowed ? t('emptyFilteredHint') : t('emptyHint')}
              // Offered only where it does something. Clearing filters is the
              // one action on this page anybody who can see it may perform;
              // uploading is not, so the untouched-library state gets advice
              // and no button.
              action={
                narrowed ? (
                  <Link
                    href="/guide"
                    className={buttonVariants({ variant: 'outline', size: 'sm' })}
                  >
                    {t('showAll')}
                  </Link>
                ) : undefined
              }
            />
          ) : (
            /*
             * NO OCR COLUMN, AND IT IS NOT AN OVERSIGHT.
             *
             * Progress is `document_pages` rows grouped by ocr_status per
             * document, and listSourceDocuments selects from source_documents
             * alone. It is not cheaply available either: database.types.ts
             * carries `Relationships: []` for source_documents, so a PostgREST
             * embed — `document_pages(count)` — does not type-check, and "done
             * of total" needs two aggregates rather than one count anyway.
             *
             * The alternatives were both worse than an absent column. A second
             * query per page load is the thing this slice was told not to add;
             * deriving a bar from `status` would be a number the database never
             * said — a 400-page cookbook sitting at 'processing' would show a
             * confident half-full bar that means nothing.
             */
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('columns.document')}</TableHead>
                  <TableHead>{t('columns.kind')}</TableHead>
                  <TableHead>{t('columns.status')}</TableHead>
                  <TableHead className="text-right">{t('columns.pages')}</TableHead>
                  <TableHead>{t('columns.uploaded')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((doc) => {
                  const status = knownStatus(doc.status)
                  return (
                    <TableRow key={doc.id}>
                      <TableCell className="max-w-md whitespace-normal">
                        {/* Not a link. There is no document page yet, and a
                            row that looks clickable and 404s is worse than a
                            row that does not. */}
                        <div className="font-medium">{doc.title ?? doc.original_filename}</div>
                        {/* The filename people recognise, kept even when a
                            title exists: it is what they uploaded and what
                            they will say out loud when asking about it.
                            Suppressed when it is already the line above,
                            rather than printed twice. */}
                        <div className="text-xs text-muted-foreground">
                          {doc.title ? `${doc.original_filename} · ` : ''}
                          {/* byte_size > 0 is a CHECK, so "0 KB" would be a
                              lie the database prevents — a 300-byte CSV
                              rounds up to 1 KB rather than down to nothing. */}
                          {doc.byte_size >= 1024 * 1024
                            ? t('sizeMb', {
                                size: format.number(doc.byte_size / (1024 * 1024), {
                                  maximumFractionDigits: 1,
                                }),
                              })
                            : t('sizeKb', {
                                size: format.number(Math.max(1, Math.round(doc.byte_size / 1024))),
                              })}
                        </div>
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {t(`kinds.${doc.kind}`)}
                      </TableCell>
                      <TableCell>
                        {status ? (
                          <Badge variant={STATUS_VARIANT[status]}>{t(`status.${status}`)}</Badge>
                        ) : (
                          <Badge variant="outline">{doc.status}</Badge>
                        )}
                      </TableCell>
                      {/* page_count is null until something counts the pages,
                          and null is not zero: "0 pages" claims an empty file.
                          The dash says the count is not known yet, which is
                          the true statement about an 'uploaded' row. */}
                      <TableCell className="text-right text-sm tabular-nums">
                        {doc.page_count ?? '—'}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">
                        {format.dateTime(new Date(doc.created_at), { dateStyle: 'medium' })}
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* Suppressed on an empty library: "Page 1 of 1 · 0 documents" restates
          the empty state in worse words. */}
      {total > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 text-sm">
          <span className="text-muted-foreground">{t('pagination', { page, lastPage, total })}</span>

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
      )}
    </div>
  )
}
