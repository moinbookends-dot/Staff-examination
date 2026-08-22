import { cn } from '@/lib/utils'

/**
 * A dashboard statistic, per the Stitch design.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ A ZERO IS A REAL ANSWER AND IS SHOWN AS ONE.                              │
 * │                                                                           │
 * │ There is no "no data" placeholder and no dash. The bank genuinely holds   │
 * │ zero questions until the dataset is imported, and "0" is the truthful     │
 * │ rendering of that — the same number it will show on the day somebody      │
 * │ archives the last question.                                               │
 * │                                                                           │
 * │ The one thing this must never do is display a plausible figure while the  │
 * │ data layer is unwired. A dashboard reading "1,245 questions" against an   │
 * │ empty database looks finished, so nobody notices, and the number ends up  │
 * │ quoted at somebody.                                                       │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export function StatCard({
  label,
  value,
  hint,
  icon,
  tone = 'default',
  className,
}: {
  label: string
  value: number | string
  hint?: string
  icon?: React.ReactNode
  tone?: 'default' | 'primary'
  className?: string
}) {
  return (
    <div
      className={cn(
        'rounded-xl border p-5',
        tone === 'primary' ? 'border-primary/30 bg-primary/5' : 'bg-card',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="text-label-caps text-muted-foreground">{label}</span>
        {icon && (
          <span aria-hidden className="shrink-0 text-muted-foreground/70">
            {icon}
          </span>
        )}
      </div>

      {/* tabular-nums so a column of figures aligns and does not shuffle
          horizontally as counts change. */}
      <p className="mt-3 text-headline-lg tabular-nums">{value}</p>

      {hint && <p className="mt-1 text-body-sm text-muted-foreground">{hint}</p>}
    </div>
  )
}

/**
 * The per-level distribution bars.
 *
 * Percentages are computed from the totals rather than from a target. The
 * Stitch design shows "Target distribution: 30% Easy, 50% Medium, 20% Hard" —
 * this system has no such target. The customer's aim is 1,000 at each level,
 * i.e. an even split, and inventing a target here would put a number on the
 * screen that nothing in the product actually holds.
 */
export function DistributionBar({
  label,
  count,
  total,
}: {
  label: string
  count: number
  total: number
}) {
  const share = total > 0 ? count / total : 0

  return (
    <div>
      <div className="flex items-baseline justify-between gap-3 text-body-sm">
        <span>{label}</span>
        <span className="tabular-nums text-muted-foreground">
          {count.toLocaleString()}
          {total > 0 && ` (${Math.round(share * 100)}%)`}
        </span>
      </div>
      <div
        className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-valuenow={Math.round(share * 100)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={label}
      >
        <div className="h-full rounded-full bg-primary" style={{ width: `${share * 100}%` }} />
      </div>
    </div>
  )
}
