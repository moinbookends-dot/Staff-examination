'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { CircleCheckIcon, ArchiveIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { InlineError } from '@/components/ui/inline-error'
import { cn } from '@/lib/utils'
import type { PaperStatus } from '@/lib/papers/repository'
import type { PaperStatusResult } from '@/server/actions/papers'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Where a printed paper is in its working life.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ "LIVE" MEANS "THIS IS THE PAPER WE ARE PRINTING", NOT "THE EXAM IS OPEN". ║
 * ║                                                                           ║
 * ║ Nobody answers anything on a screen because of this control. Candidates   ║
 * ║ sit these papers on paper; the label exists so that twelve equally        ║
 * ║ printable papers in the history list stop looking identical, and the one  ║
 * ║ actually in use this week is obvious.                                     ║
 * ║                                                                           ║
 * ║ The wording matters and is chosen deliberately — "In use" rather than     ║
 * ║ "Published", "Retire" rather than "Close" — because the first pair would  ║
 * ║ imply an online sitting that does not exist.                              ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */

export const STATUS_TONE: Record<PaperStatus, string> = {
  generated: 'border-muted-foreground/30 text-muted-foreground',
  live: 'border-emerald-500/40 text-emerald-700 dark:text-emerald-400',
  retired: 'border-amber-500/30 text-amber-700 dark:text-amber-400',
}

export function PaperStatusBadge({ status }: { status: PaperStatus }) {
  const t = useTranslations('papers')
  return (
    <Badge variant="outline" className={cn(STATUS_TONE[status])}>
      {t(`status.${status}` as 'status.generated')}
    </Badge>
  )
}

export interface PaperStatusControlProps {
  paperId: string
  status: PaperStatus
  onChange: (input: { paperId: string; status: 'live' | 'retired' }) => Promise<PaperStatusResult>
}

export function PaperStatusControl({ paperId, status, onChange }: PaperStatusControlProps) {
  const t = useTranslations('papers')
  const [pending, startTransition] = useTransition()
  const [current, setCurrent] = useState<PaperStatus>(status)
  const [error, setError] = useState<string | null>(null)

  const move = (next: 'live' | 'retired') => {
    setError(null)
    startTransition(async () => {
      const result = await onChange({ paperId, status: next })
      if (result.ok) {
        setCurrent(result.status)
        toast.success(t(`statusSet.${result.status}` as 'statusSet.live', { no: result.paperNo }))
      } else {
        setError(result.message)
      }
    })
  }

  return (
    <div className="space-y-3">
      {error && <InlineError>{error}</InlineError>}

      <div className="flex flex-wrap items-center gap-3">
        <PaperStatusBadge status={current} />

        {/*
          `generated` is never offered as a destination. 0061 refuses a return
          to the state a paper is born in — a paper that has been in a room
          with candidates is never again one that has not — so a button for it
          would be a control that always fails.
        */}
        {current !== 'live' && (
          <Button size="sm" disabled={pending} onClick={() => move('live')}>
            <CircleCheckIcon />
            {t('setLive')}
          </Button>
        )}

        {current !== 'retired' && (
          <Button size="sm" variant="outline" disabled={pending} onClick={() => move('retired')}>
            <ArchiveIcon />
            {t('setRetired')}
          </Button>
        )}
      </div>

      <p className="text-body-sm text-muted-foreground">{t(`statusHint.${current}` as 'statusHint.generated')}</p>
    </div>
  )
}
