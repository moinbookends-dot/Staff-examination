import { TriangleAlert } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * A form-level failure, shown in place.
 *
 * `<p className="rounded-md border border-destructive p-3 text-sm text-destructive">`
 * appeared verbatim in five files. Beyond the duplication, none of them
 * announced itself: a server action that fails validation swaps in a paragraph
 * that a screen-reader user has no way of knowing appeared, because focus
 * never moves and nothing is live.
 *
 * `role="alert"` is an implicit aria-live region, so the message is read out
 * when it arrives. That is the actual reason this component exists; the
 * de-duplication is a side benefit.
 */
export function InlineError({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <p
      role="alert"
      className={cn(
        'flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/8 p-3 text-sm text-destructive',
        className,
      )}
    >
      <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  )
}
