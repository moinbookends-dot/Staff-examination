import type { LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * What a list looks like before anybody has done anything.
 *
 * Every one of these was previously a bare
 * `<p className="py-10 text-center text-sm text-muted-foreground">`, which is
 * indistinguishable from a page that failed to load its data.
 *
 * `action` is passed only when the viewer can actually perform it. An empty
 * state that offers "New exam" to somebody without exams.create is worse than
 * no empty state: it teaches them the product is broken when the click 403s.
 *
 * The message text node is load-bearing — the render check pins
 * `/>Nothing to report yet/` — so the sentence sits directly inside its
 * element with nothing in front of it.
 */
export function EmptyState({
  icon: Icon,
  message,
  hint,
  action,
  className,
}: {
  icon?: LucideIcon
  message: React.ReactNode
  hint?: React.ReactNode
  action?: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-3 px-6 py-12 text-center',
        className,
      )}
    >
      {Icon && (
        <span
          aria-hidden
          className="grid size-11 place-items-center rounded-xl border border-dashed text-muted-foreground"
        >
          <Icon className="size-5" />
        </span>
      )}
      <p className="text-sm font-medium">{message}</p>
      {hint && <p className="max-w-sm text-sm text-balance text-muted-foreground">{hint}</p>}
      {action && <div className="pt-1">{action}</div>}
    </div>
  )
}
