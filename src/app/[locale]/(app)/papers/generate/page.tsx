import { getTranslations } from 'next-intl/server'
import { requirePermission } from '@/lib/auth/guards'
import { PageHeader } from '@/components/ui/page-header'
import { GenerateEmptyState, GeneratePanel } from '@/components/papers/generate-panel'
import { loadGenerateAvailability } from '@/server/papers/availability'
import type { Difficulty } from '@/lib/bank/vocabulary'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * /papers/generate — the Chef's whole job.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ A SERVER COMPONENT THAT PASSES ONLY DATA.                                 │
 * │                                                                           │
 * │ GeneratePanel is a Client Component, so everything crossing this boundary │
 * │ is serialised. Permission predicates are evaluated HERE and the result is │
 * │ never forwarded as a function — the same mistake that took the shell down │
 * │ when nav items carried their `guard` across.                              │
 * │                                                                           │
 * │ `onGenerate` is deliberately not passed yet. It will be a Server Action,  │
 * │ which IS legal across the boundary; until the repository adapter exists   │
 * │ there is nothing for it to call, and its absence is what disables the     │
 * │ button — one source of truth rather than a separate "connected" flag.     │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */
export default async function GeneratePaperPage() {
  /*
   * The whole gate. canGeneratePapers() from bank-access is exactly
   * can(claims, 'papers.generate'), so calling it here as well would be the
   * same check twice under two names — and a second, differently-spelled copy
   * of a permission rule is how the two eventually disagree.
   *
   * The bank-access predicates exist for the rules requirePermission CANNOT
   * express, notably the Super Admin lockout on the Question Bank. This is not
   * one of those.
   */
  await requirePermission('papers.generate')

  const t = await getTranslations('papers')
  const availability = await loadGenerateAvailability()

  /*
   * Difficulty labels come from exam_settings once it is readable. Until then
   * the translated defaults are used — NOT a hard-coded English string, so a
   * Hindi-speaking chef sees Hindi either way.
   */
  const difficultyLabels: Record<Difficulty, string> = {
    easy: t('difficulty.easy'),
    medium: t('difficulty.medium'),
    hard: t('difficulty.hard'),
  }

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <PageHeader title={t('generateTitle')} description={t('generateSubtitle')} />

      {availability.hasQuestions ? (
        <GeneratePanel availability={availability} difficultyLabels={difficultyLabels} />
      ) : (
        <GenerateEmptyState />
      )}
    </div>
  )
}
