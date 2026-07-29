import type { LucideIcon } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/**
 * One figure, named.
 *
 * Lifted verbatim from the local `Stat` in reports/page.tsx, which was the only
 * place in the app that knew how a headline number should look. The dashboard
 * and the evaluation queues each want the same thing.
 *
 * `tabular-nums` is not decoration: a column of scores that jumps left and
 * right as the digits change is measurably harder to scan, and the whole point
 * of these tiles is being scanned.
 *
 * The label stays a bare text node — the render check pins `/>Exams taken</`.
 * The icon is a following sibling for that reason, not a leading one.
 */
export function StatTile({
  label,
  value,
  hint,
  icon: Icon,
  className,
}: {
  label: React.ReactNode
  value: React.ReactNode
  hint?: React.ReactNode
  icon?: LucideIcon
  className?: string
}) {
  return (
    <Card className={cn('relative', className)}>
      <CardContent className="pt-6">
        <div className="flex items-start justify-between gap-2">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {label}
          </p>
          {Icon && <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground/50" />}
        </div>
        <p className="mt-2 font-heading text-2xl font-semibold tabular-nums">{value}</p>
        {hint && <p className="mt-1 text-xs text-muted-foreground">{hint}</p>}
      </CardContent>
    </Card>
  )
}
