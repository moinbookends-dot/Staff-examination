import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@/components/ui/page-header'
import { EmptyState } from '@/components/ui/empty-state'
import { ImportPanel, type CommitResult } from '@/components/bank/import-panel'
import { ImportTabs } from '@/components/bank/import-tabs'
import { ImportHistory } from '@/components/bank/import-history'
import { PaperImportPanel, type PaperCommitOutcome } from '@/components/bank/paper-import-panel'
import { loadImportOptions, loadImportRuns, loadPaperImportOptions } from '@/server/papers/bank-data'
import { commitImport } from '@/server/actions/import'
import { commitPaperImport, recordImportRun, resolvePaperTargets } from '@/server/actions/paper-import'
import { createTopic } from '@/server/actions/topics'
import { getAppClaims } from '@/lib/auth/claims'
import { can } from '@/lib/auth/can'
import { topicSlug } from '@/lib/bank/import/format'
import type { CommitRow } from '@/lib/bank/import/commit'
import type { BankFact } from '@/lib/bank/paper/types'
import type { PaperCommitRow } from '@/lib/bank/paper/commit'
import type { BankLocale } from '@/lib/bank/vocabulary'
import { BuildingIcon } from 'lucide-react'

/**
 * /questions/import — Editor only, by virtue of the subtree layout.
 *
 * The layout at src/app/[locale]/(app)/questions/layout.tsx gates this whole
 * subtree on canOpenQuestionBank, so this page carries no permission check of
 * its own — and must not grow one that disagrees with it. Every action below
 * re-checks independently, because navigation and layout are not authorisation.
 *
 * TWO IMPORTERS, ONE IDENTITY CONTRACT. The JSON tab reads a curated dataset;
 * the Paper tab reads a printed question paper and its answer key. Both match
 * on externalId, both go through bank_import_commit(), and neither has its own
 * notion of what makes two questions the same.
 */
export default async function ImportPage() {
  const t = await getTranslations('import')
  const [options, paperOptions, runs, claims] = await Promise.all([
    loadImportOptions(),
    loadPaperImportOptions(),
    loadImportRuns(),
    getAppClaims(),
  ])

  /*
   * The brand a question lands in.
   *
   * An Editor pinned to a brand imports into that brand and is not offered a
   * choice; an unscoped Editor picks. Defaulting to the first brand rather
   * than to null means the button is never enabled with nothing selected.
   */
  const defaultBrandId =
    (claims.brand_id && options.brands.some((b) => b.id === claims.brand_id)
      ? claims.brand_id
      : options.brands[0]?.id) ?? ''

  const visibleBrands = claims.brand_id
    ? options.brands.filter((b) => b.id === claims.brand_id)
    : options.brands

  // Server Actions, which are the one kind of function that may cross into a
  // Client Component — React passes a reference, not the function itself.
  const onCommit = async (brandId: string, rows: CommitRow[]): Promise<CommitResult> => {
    'use server'
    return commitImport(brandId, rows)
  }

  const onResolve = async (
    brandId: string,
    externalIds: string[],
  ): Promise<{ ok: true; facts: BankFact[] } | { ok: false; message: string }> => {
    'use server'
    return resolvePaperTargets(brandId, externalIds)
  }

  const onCommitPaper = async (input: {
    brandId: string
    locale: BankLocale
    rows: PaperCommitRow[]
  }): Promise<PaperCommitOutcome> => {
    'use server'
    return commitPaperImport(input)
  }

  /*
   * Wrapped rather than passed through, so the panel receives the SLUG it has
   * to map a heading to. createTopic returns the row id, which is of no use to
   * a screen whose whole job is producing a slug — and re-deriving it in the
   * browser would be a second copy of a rule that already has one home.
   */
  const onCreateTopic = async (
    name: string,
  ): Promise<{ ok: true; slug: string } | { ok: false; message: string }> => {
    'use server'
    const result = await createTopic({ name })
    return result.ok ? { ok: true, slug: topicSlug(name) } : result
  }

  const onRecordRun = async (input: unknown): Promise<{ recorded: boolean }> => {
    'use server'
    return recordImportRun(input)
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('title')} description={t('subtitle')} />

      {/* Questions are brand-scoped and brand_id is NOT NULL, so with no brand
          there is nowhere for a question to go. Said plainly rather than
          rendering a file picker that cannot succeed. */}
      {visibleBrands.length === 0 ? (
        <EmptyState icon={BuildingIcon} message={t('chooseBrand')} hint={t('subtitle')} />
      ) : (
        <ImportTabs
          json={
            <ImportPanel
              brands={visibleBrands}
              defaultBrandId={defaultBrandId}
              knownTopics={options.topicSlugs}
              requiredLocales={options.requiredLocales}
              existingExternalIds={options.existingExternalIds}
              difficultyLabels={options.difficultyLabels}
              // Evaluated here, on the server. The predicate itself must never
              // cross the boundary — only its result.
              canExport={can(claims, 'bank.export')}
              onCommit={onCommit}
            />
          }
          paper={
            <PaperImportPanel
              brands={visibleBrands}
              defaultBrandId={defaultBrandId}
              topics={paperOptions.topics}
              difficultyLabels={paperOptions.difficultyLabels}
              canCreateTopics={can(claims, 'bank.write')}
              onResolve={onResolve}
              onCommit={onCommitPaper}
              onCreateTopic={onCreateTopic}
              onRecordRun={onRecordRun}
            />
          }
        />
      )}

      <ImportHistory runs={runs} />
    </div>
  )
}
