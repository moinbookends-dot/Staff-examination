import { getTranslations } from 'next-intl/server'
import { PapersTabs } from '@/components/papers/papers-tabs'
import { requirePermission } from '@/lib/auth/guards'
import { getAppClaims } from '@/lib/auth/claims'
import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/ui/page-header'
import { GenerateEmptyState, GeneratePanel } from '@/components/papers/generate-panel'
import { loadGenerateAvailability } from '@/server/papers/availability'
import { generatePaper } from '@/server/actions/papers'
import type { Difficulty } from '@/lib/bank/vocabulary'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * /papers/generate — the Chef's whole job.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ A SERVER COMPONENT THAT PASSES ONLY DATA — AND ONE SERVER ACTION.         │
 * │                                                                           │
 * │ GeneratePanel is a Client Component, so everything crossing this boundary │
 * │ is serialised. Permission predicates are evaluated HERE and the result is │
 * │ never forwarded as a function — the same mistake that took the shell down │
 * │ when nav items carried their `guard` across.                              │
 * │                                                                           │
 * │ `onGenerate` IS a function, and is the one kind that may cross: a Server  │
 * │ Action is passed as a serialisable reference. Its presence is what        │
 * │ enables the button; the panel gates on the prop rather than on a separate │
 * │ "connected" flag, so this page is the single source of that truth.        │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */
export default async function GeneratePaperPage() {
  /*
   * The whole gate. canGeneratePapers() from bank-access is exactly
   * can(claims, 'papers.generate'), so calling it here as well would be the
   * same check twice under two names — and a second, differently-spelled copy
   * of a permission rule is how the two eventually disagree.
   */
  await requirePermission('papers.generate')

  const t = await getTranslations('papers')
  const claims = await getAppClaims()
  const supabase = await createClient()

  /*
   * ┌─────────────────────────────────────────────────────────────────────────┐
   * │ A PAPER BELONGS TO EXACTLY ONE BRAND, SO ONE HAS TO BE CHOSEN.          │
   * │                                                                         │
   * │ exam_papers.brand_id is NOT NULL and the draw is per-brand. This screen  │
   * │ previously resolved no brand at all and counted the pool across ALL of   │
   * │ them, so the numbers on the page could not be produced by any single     │
   * │ draw.                                                                    │
   * │                                                                         │
   * │ Same shape as /questions/import: a brand-pinned Chef sees no chooser and │
   * │ gets theirs forced server-side; an unscoped Editor picks. The action     │
   * │ re-decides this regardless of what the client sends.                     │
   * └─────────────────────────────────────────────────────────────────────────┘
   */
  const { data: brandRows } = await supabase
    .from('brands')
    .select('id, name')
    .is('deleted_at', null)
    .order('name')

  const allBrands = brandRows ?? []
  const brands = claims.brand_id
    ? allBrands.filter((b) => b.id === claims.brand_id)
    : allBrands

  const selectedBrandId = brands[0]?.id ?? null

  // Counts for the brand actually being drawn from, so what the screen promises
  // is what the generator can deliver.
  const availability = await loadGenerateAvailability(selectedBrandId ?? undefined)

  /*
   * ┌─────────────────────────────────────────────────────────────────────────┐
   * │ TRANSLATED, NOT READ FROM exam_settings.                                │
   * │                                                                         │
   * │ This used to prefer settings.difficultyLabels with a translated string  │
   * │ as the fallback. The column is NOT NULL with a default of 'Easy', so    │
   * │ that fallback could never fire and a Hindi-speaking chef was shown      │
   * │ English level names on a fully Hindi screen.                            │
   * │                                                                         │
   * │ A single stored string cannot be trilingual, and the product already    │
   * │ knows its own level names in all three languages. The PDF route makes   │
   * │ the same call for the same reason, so screen and paper agree.           │
   * └─────────────────────────────────────────────────────────────────────────┘
   */
  const difficultyLabels: Record<Difficulty, string> = {
    easy: t('difficulty.easy'),
    medium: t('difficulty.medium'),
    hard: t('difficulty.hard'),
  }

  // Wrapped so the panel takes a plain callback and never has to know an action
  // from an ordinary function.
  const onGenerate = async (input: { difficulty: Difficulty; marks: number; brandId?: string }) => {
    'use server'
    return generatePaper(input)
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PapersTabs />
      <PageHeader title={t('generateTitle')} description={t('generateSubtitle')} />

      {availability.hasQuestions ? (
        <GeneratePanel
          availability={availability}
          difficultyLabels={difficultyLabels}
          brands={brands}
          defaultBrandId={selectedBrandId}
          onGenerate={onGenerate}
        />
      ) : (
        <GenerateEmptyState />
      )}
    </div>
  )
}
