import { DatabaseZap } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A panel that has a design and does not yet have data.
 *
 * WHY THIS EXISTS RATHER THAN A CHART FULL OF PLAUSIBLE NUMBERS.
 *
 * The reference design carries panels — a weekly engagement chart,
 * period-over-period trend deltas, a department rollup, a live audit feed —
 * that no query in this system can answer. Each would take about ten minutes
 * to fill with numbers that look right, and every one of those numbers would
 * be a lie told to a manager deciding who needs retraining.
 *
 * The original dashboard's docblock made the same call for the same reason:
 * "a dashboard showing invented data is worse than one showing less". This
 * component is that rule made reusable, and visible: the panel keeps its place
 * in the layout, states plainly that it is waiting on the database, and names
 * what it is waiting for — so it reads as a known gap rather than as a bug, and
 * whoever picks it up does not have to reverse-engineer the requirement.
 *
 * `requirement` is developer-facing and deliberately NOT translated: it names
 * SQL functions and columns, and nobody without a schema in front of them can
 * act on it. It is rendered small and muted for that reason.
 * ═══════════════════════════════════════════════════════════════════════════
 */
export function BackendRequired({
  title,
  label,
  description,
  requirement,
  className,
  children,
}: {
  title: React.ReactNode
  /** Translated "Backend required" chip. */
  label: string
  /** Translated, user-facing: what this panel WILL show. */
  description: React.ReactNode
  /** Untranslated, developer-facing: the exact SQL or API needed. */
  requirement: string
  className?: string
  /** Optional inert visual, e.g. a greyed axis, to hold the panel's shape. */
  children?: React.ReactNode
}) {
  return (
    <Card className={cn('border-dashed', className)}>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-base">{title}</CardTitle>
          <span className="inline-flex items-center gap-1.5 rounded-full bg-warning/14 px-2 py-0.5 text-xs font-medium text-warning">
            <DatabaseZap aria-hidden className="size-3" />
            {label}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">{description}</p>
        {children}
        <p className="rounded-lg bg-muted/60 p-2.5 font-mono text-[0.7rem] leading-relaxed text-muted-foreground">
          {requirement}
        </p>
      </CardContent>
    </Card>
  )
}
