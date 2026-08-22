'use client'

import { useTranslations } from 'next-intl'
import type { QuestionHealth } from '@/lib/questions/health'
import { Badge } from '@/components/ui/badge'

/**
 * The completeness flags on a question, as badges.
 *
 * Reads `item.health` and renders it. The rule lives in one place —
 * questionHealth() in src/lib/questions/health.ts — and deciding anything here
 * would be a second copy of it that only the table can see.
 *
 * Severity is a presentation choice and belongs here rather than in the rule:
 * a missing answer key would grade every candidate at zero, while a missing
 * Bloom level is paperwork. Both are "incomplete" to the rule; only one of them
 * should be red.
 */
const VARIANT: Record<string, 'destructive' | 'warning' | 'secondary'> = {
  'no-answer-key': 'destructive',
  // Not cosmetic: draw_paper selects BY CATEGORY, so an uncategorised question
  // can never be drawn by a rule. It is dead stock that looks healthy.
  'no-category': 'warning',
  'no-bloom': 'secondary',
  untranslated: 'secondary',
}

export function QuestionHealthBadges({ health }: { health: QuestionHealth[] }) {
  const t = useTranslations('questions.health')

  if (health.length === 0) {
    // Deliberately quiet. A green "Complete" badge on the overwhelming majority
    // of rows is a column of noise that hides the handful that need attention.
    return <span className="text-muted-foreground">—</span>
  }

  return (
    <span className="flex flex-wrap gap-1">
      {health.map((entry) => (
        /*
         * data-health is what the render check asserts against, and it cannot
         * assert on the label instead: next-intl serialises the whole message
         * bundle into the page, so `html.includes('No answer key')` is true
         * whether or not a single badge rendered. That is the same trap the
         * render check already records for 'Food Safety'.
         *
         * Badge is built on Base UI's useRender, which spreads unrecognised
         * props onto the element alongside its own data-slot/data-variant, so
         * this arrives in the markup as written.
         */
        <Badge key={entry.flag} data-health={entry.flag} variant={VARIANT[entry.flag] ?? 'secondary'}>
          {entry.flag === 'untranslated'
            ? t('untranslated', { locales: (entry.detail ?? []).join(', ').toUpperCase() })
            : t(entry.flag)}
        </Badge>
      ))}
    </span>
  )
}
