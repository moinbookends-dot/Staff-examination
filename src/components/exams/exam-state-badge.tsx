import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { ExamState } from '@/lib/exams/state'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * PAPER, EXAM, LIVE EXAM — three different things, three different words.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THIS BADGE IS NOT PaperStatusBadge, AND THEY MUST NOT MERGE.             │
 * │                                                                           │
 * │ A PAPER is generated/live/retired — where "live" means "this is the one   │
 * │ we are printing this week". An EXAM is draft/scheduled/live/closed/       │
 * │ cancelled — where "live" means "candidates can sit it right now".         │
 * │                                                                           │
 * │ The same word, two meanings, on two objects that appear on the same       │
 * │ screen. Sharing one component would make it impossible to give them       │
 * │ different colours, and the colours are how a reader tells them apart at   │
 * │ a glance.                                                                 │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */

const TONE: Record<ExamState, string> = {
  // The only state that means "act now", and the only one given a solid fill.
  live: 'border-transparent bg-emerald-600 text-white dark:bg-emerald-500',
  scheduled: 'border-sky-500/40 text-sky-700 dark:text-sky-400',
  draft: 'border-muted-foreground/30 text-muted-foreground',
  closed: 'border-muted-foreground/25 text-muted-foreground',
  cancelled: 'border-destructive/40 text-destructive',
}

export function ExamStateBadge({
  state,
  label,
  className,
}: {
  state: ExamState
  /** Already translated by the caller — this is a Server Component. */
  label: string
  className?: string
}) {
  return (
    <Badge variant="outline" className={cn(TONE[state], className)}>
      {state === 'live' && (
        // A quiet pulse, only on the one state that changes minute to minute.
        <span
          aria-hidden
          className="mr-1.5 inline-block size-1.5 shrink-0 rounded-full bg-current motion-safe:animate-pulse"
        />
      )}
      {label}
    </Badge>
  )
}
