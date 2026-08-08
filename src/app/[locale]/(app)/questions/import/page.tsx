import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@/components/ui/page-header'
import { EmptyState } from '@/components/ui/empty-state'
import { ImportPanel, type CommitResult } from '@/components/bank/import-panel'
import { loadImportOptions } from '@/server/papers/bank-data'
import { commitImport } from '@/server/actions/import'
import { getAppClaims } from '@/lib/auth/claims'
import { can } from '@/lib/auth/can'
import type { CommitRow } from '@/lib/bank/import/commit'
import { BuildingIcon } from 'lucide-react'

/**
 * /questions/import — Editor only, by virtue of the subtree layout.
 *
 * The layout at src/app/[locale]/(app)/questions/layout.tsx gates this whole
 * subtree on canOpenQuestionBank, so this page carries no permission check of
 * its own — and must not grow one that disagrees with it. commitImport()
 * re-checks independently, because navigation and layout are not authorisation.
 */
export default async function ImportPage() {
  const t = await getTranslations('import')
  const options = await loadImportOptions()
  const claims = await getAppClaims()

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

  // A Server Action, which is the one kind of function that may cross into a
  // Client Component — React passes a reference, not the function itself.
  const onCommit = async (brandId: string, rows: CommitRow[]): Promise<CommitResult> => {
    'use server'
    return commitImport(brandId, rows)
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageHeader title={t('title')} description={t('subtitle')} />

      {/* Questions are brand-scoped and brand_id is NOT NULL, so with no brand
          there is nowhere for a question to go. Said plainly rather than
          rendering a file picker that cannot succeed. */}
      {visibleBrands.length === 0 ? (
        <EmptyState icon={BuildingIcon} message={t('chooseBrand')} hint={t('subtitle')} />
      ) : (
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
      )}
    </div>
  )
}
