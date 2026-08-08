import { getTranslations } from 'next-intl/server'
import { DatabaseIcon, DownloadIcon, PlusIcon, UploadIcon } from 'lucide-react'
import { getAppClaims } from '@/lib/auth/claims'
import { requireApproved } from '@/lib/auth/guards'
import { AuthorizationError } from '@/lib/auth/guards'
import { canEditQuestions, canOpenQuestionBank } from '@/lib/auth/bank-access'
import { can } from '@/lib/auth/can'
import { Link } from '@/lib/i18n/navigation'
import { PageHeader } from '@/components/ui/page-header'
import { EmptyState } from '@/components/ui/empty-state'
import { buttonVariants } from '@/components/ui/button'
import { QuestionList } from '@/components/bank/question-list'
import { loadFormOptions, loadQuestionPage } from '@/server/papers/bank-data'
import { cn } from '@/lib/utils'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Question Bank — Editor only.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THIS ROUTE WAS REACHABLE BY A CHEF AND THAT WAS A REAL HOLE.              ║
 * ║                                                                           ║
 * ║ The page that stood here belonged to the old nine-format question bank    ║
 * ║ and gated on requirePermission('questions.read') — a permission the chef  ║
 * ║ role holds. So while the navigation correctly offered no link, typing the ║
 * ║ URL rendered the whole bank at 200.                                       ║
 * ║                                                                           ║
 * ║ Found by scripts/check-shell.mjs asserting the route as well as the nav.  ║
 * ║ A hidden link is not an access control; the route has to refuse.          ║
 * ║                                                                           ║
 * ║ THE GATE IS canOpenQuestionBank, NOT requirePermission('bank.read'):      ║
 * ║ has_perm() short-circuits true for super_admin, so a permission check     ║
 * ║ alone would admit the one role that is deliberately excluded. The         ║
 * ║ predicate is the governance boundary and it is the same function the nav  ║
 * ║ and the server actions call.                                              ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE EMPTY STATE IS NOW CONDITIONAL, AND IT USED TO BE UNCONDITIONAL.      │
 * │                                                                           │
 * │ This page rendered EmptyState whatever the bank held — it never queried   │
 * │ the database at all. That was correct while bank_questions did not exist, │
 * │ and became a bug the moment the migrations landed: importing 3,000        │
 * │ questions left the Question Bank still reading "empty", which is the one  │
 * │ thing a data screen must never do.                                        │
 * │                                                                           │
 * │ Caught by the stabilization audit, which found zero database references   │
 * │ in a file whose whole purpose is to list rows.                            │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */
export default async function QuestionBankPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string }>
}) {
  await requireApproved()

  const claims = await getAppClaims()
  if (!canOpenQuestionBank(claims)) {
    throw new AuthorizationError('The Question Bank is available to Editors only.', 'bank.read')
  }

  const t = await getTranslations('bank')
  const { page } = await searchParams

  // Number('abc') is NaN and Number('') is 0, so both fall back to page 1
  // rather than reaching the loader as a nonsense range.
  const requested = Number(page)
  const current = Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : 1

  const [questions, options] = await Promise.all([
    loadQuestionPage({ page: current }),
    loadFormOptions(),
  ])

  const canWrite = canEditQuestions(claims)
  const canExport = can(claims, 'bank.export')

  // Their own brand when pinned, otherwise the first they can see. The handler
  // re-decides this server-side — a pinned Editor cannot widen it by editing
  // the query string — so this only has to produce a link that works.
  const exportBrandId =
    (claims.brand_id && options.brands.some((b) => b.id === claims.brand_id)
      ? claims.brand_id
      : options.brands[0]?.id) ?? null
  const lastPage = Math.max(1, Math.ceil(questions.total / questions.pageSize))

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('title')}
        description={
          questions.total > 0 ? t('countLabel', { count: questions.total }) : t('subtitle')
        }
        actions={
          canWrite ? (
            <div className="flex flex-wrap gap-2">
              <Link
                href="/questions/import"
                className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
              >
                <UploadIcon />
                {t('import')}
              </Link>

              {/*
                The export is an /api route, not a page — it answers with a file
                and a Content-Disposition header. This linked to /questions/export,
                which has never existed, so the button 404d. Found in the
                stabilization audit; nav.ts already carries the rule it broke:
                a link is a promise about a route, and the route has to keep it.

                A plain <a>, not <Link>: next/link prefetches and client-navigates,
                neither of which is meaningful for a download.
              */}
              {/*
                A plain <a>, not <Link>: /api/bank/export is a Route Handler that
                answers with a file and a Content-Disposition header. <Link> would
                client-navigate and the download would never start.

                THE BRAND IS EXPLICIT because the handler answers 400 without one.
                A brand-pinned Editor has theirs forced server-side regardless of
                what the query says; an unscoped Editor needs a brand named here or
                the button fails. This linked to /questions/export — a route that has
                never existed — until the stabilization audit found the 404.
              */}
              {canExport && questions.total > 0 && exportBrandId && (
                <a
                  href={`/api/bank/export?brand=${encodeURIComponent(exportBrandId)}`}
                  className={cn(buttonVariants({ variant: 'outline', size: 'sm' }))}
                >
                  <DownloadIcon />
                  {t('export')}
                </a>
              )}

              <Link href="/questions/new" className={cn(buttonVariants({ size: 'sm' }))}>
                <PlusIcon />
                {t('create')}
              </Link>
            </div>
          ) : undefined
        }
      />

      {questions.total === 0 ? (
        <EmptyState
          icon={DatabaseIcon}
          message={t('empty')}
          hint={t('emptyHint')}
          action={
            canWrite ? (
              <Link href="/questions/import" className={cn(buttonVariants({ size: 'sm' }))}>
                <UploadIcon />
                {t('import')}
              </Link>
            ) : undefined
          }
        />
      ) : (
        <>
          <QuestionList
            rows={questions.rows}
            difficultyLabels={options.difficultyLabels}
            typeLabels={{ mcq: t('type.mcq'), short_answer: t('type.short_answer') }}
            labels={{
              question: t('colQuestion'),
              difficulty: t('colDifficulty'),
              type: t('colType'),
              topic: t('colTopic'),
              status: t('colStatus'),
              languages: t('colLanguages'),
              uuid: t('colUuid'),
              untitled: t('untitled'),
            }}
          />

          {lastPage > 1 && (
            <nav className="flex items-center justify-between gap-3" aria-label="Pagination">
              <Link
                href={`/questions?page=${current - 1}`}
                aria-disabled={current <= 1}
                className={cn(
                  buttonVariants({ variant: 'outline', size: 'sm' }),
                  current <= 1 && 'pointer-events-none opacity-50',
                )}
              >
                {t('prev')}
              </Link>

              <span className="text-body-sm text-muted-foreground">
                {t('pageOf', { page: current, total: lastPage })}
              </span>

              <Link
                href={`/questions?page=${current + 1}`}
                aria-disabled={current >= lastPage}
                className={cn(
                  buttonVariants({ variant: 'outline', size: 'sm' }),
                  current >= lastPage && 'pointer-events-none opacity-50',
                )}
              >
                {t('next')}
              </Link>
            </nav>
          )}
        </>
      )}
    </div>
  )
}
