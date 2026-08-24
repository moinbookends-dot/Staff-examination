import { getTranslations } from 'next-intl/server'
import { PapersTabs } from '@/components/papers/papers-tabs'
import { requirePermission } from '@/lib/auth/guards'
import { getAppClaims } from '@/lib/auth/claims'
import { createClient } from '@/lib/supabase/server'
import { PageHeader } from '@/components/ui/page-header'
import { GenerateEmptyState, GeneratePanel } from '@/components/papers/generate-panel'
import {
  loadEligibleCounts,
  loadGenerateAvailability,
  loadItemPool,
  loadTopicPool,
} from '@/server/papers/availability'
import { generatePaper } from '@/server/actions/papers'
import { setItemUsage } from '@/server/actions/items'
import { can } from '@/lib/auth/can'
import { DIFFICULTIES, type Difficulty } from '@/lib/bank/vocabulary'

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
/**
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE BRAND AND LEVEL LIVE IN THE URL, AND THAT IS THE WHOLE FIX.           │
 * │                                                                           │
 * │ This screen showed one brand's counts while another was selected. The     │
 * │ counts were never wrong — bank_pool_counts is brand-scoped and always     │
 * │ was — but they were fetched once, for brands[0], and the dropdown only    │
 * │ ever moved a piece of client state. Nothing re-ran the query, so picking  │
 * │ Capiche left Aiko's 1,030 on screen, enabled the button, and handed the   │
 * │ draw a level with no questions in it.                                     │
 * │                                                                           │
 * │ Putting both in searchParams makes the SERVER the thing that recomputes,  │
 * │ which is the shape /questions already uses for its brand filter. A URL    │
 * │ that names what it is showing is also shareable, reloadable, and cannot   │
 * │ drift from the numbers beside it.                                         │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export default async function GeneratePaperPage({
  searchParams,
}: {
  searchParams: Promise<{ brand?: string; level?: string }>
}) {
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

  const { brand: brandParam, level: levelParam } = await searchParams

  /*
   * The query string is a request, not an instruction. A pinned Chef reads
   * their own brand whatever the URL says, and an id naming a brand this
   * caller cannot see falls back to the first they can — never to null,
   * which bank_pool_counts would read as "every brand" and sum two banks.
   */
  const selectedBrandId =
    (claims.brand_id && brands.some((b) => b.id === claims.brand_id)
      ? claims.brand_id
      : (brands.find((b) => b.id === brandParam)?.id ?? brands[0]?.id)) ?? null

  // Counts for the brand actually being drawn from, so what the screen promises
  // is what the generator can deliver.
  const availability = selectedBrandId
    ? await loadGenerateAvailability(selectedBrandId)
    : { levels: [], sizes: [], hasQuestions: false, poolCountsVisible: false }

  const selectedLevel = DIFFICULTIES.find((d) => d === levelParam) ?? null

  /*
   * The topics that actually carry questions for this brand AND level — so
   * the picker cannot offer a topic that would exclude nothing. Loaded only
   * once a level is chosen, because the list is different for each one.
   */
  const [topicPool, itemPool] =
    selectedBrandId && selectedLevel
      ? await Promise.all([
          loadTopicPool(selectedBrandId, selectedLevel, t('topicNone')),
          loadItemPool(selectedBrandId, selectedLevel, t('itemNone')),
        ])
      : [[], []]

  /*
   * THE POOL THE BUTTON IS GATED ON, COUNTED BY THE DATABASE.
   *
   * Items overlap — a question comparing two dishes belongs to both — so the
   * browser cannot arrive at this by subtracting per-item counts without
   * removing such a question twice. The same predicates the draw uses are
   * run here, against the standing in_use flags, so the figure on screen is
   * the figure the generator will find.
   */
  const eligible =
    selectedBrandId && selectedLevel
      ? await loadEligibleCounts(selectedBrandId, selectedLevel, {
          topicIds: null,
          includeNoTopic: true,
          excludedItemIds: itemPool
            .filter((i) => !i.inUse && i.id !== null)
            .map((i) => i.id as string),
          includeNoItem: true,
        })
      : { mcq: 0, shortAnswer: 0 }

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
  const onGenerate = async (input: {
    difficulty: Difficulty
    marks: number
    brandId?: string
    topicIds?: string[]
    includeNoTopic?: boolean
    excludedItemIds?: string[]
    includeNoItem?: boolean
  }) => {
    'use server'
    return generatePaper(input)
  }

  /*
   * Only wired for somebody who may edit the bank. The panel hides the
   * controls when the prop is absent, which is the same pattern onGenerate
   * uses — a disabled control nobody can explain is worse than no control.
   * setItemUsage re-checks the permission regardless of what reaches it.
   */
  const onSetItemUsage = can(claims, 'bank.write')
    ? async (input: { itemId: string; inUse: boolean }) => {
        'use server'
        return setItemUsage(input)
      }
    : undefined

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
          selectedDifficulty={selectedLevel}
          topicPool={topicPool}
          itemPool={itemPool}
          eligible={eligible}
          onSetItemUsage={onSetItemUsage}
          onGenerate={onGenerate}
        />
      ) : (
        <GenerateEmptyState />
      )}
    </div>
  )
}
