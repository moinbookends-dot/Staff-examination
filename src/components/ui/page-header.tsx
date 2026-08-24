import { cn } from '@/lib/utils'

/**
 * The block at the top of every page: title, one-line description, and the
 * primary action for the screen.
 *
 * This exact markup — `flex flex-wrap items-start justify-between gap-3` around
 * an h1 and a muted paragraph — was written out by hand on fourteen pages, and
 * had already drifted: some pages used gap-2, some had no description, one used
 * text-xl. Centralising it is what makes a change to heading rhythm a one-file
 * change rather than a fourteen-file sweep.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE TITLE MUST STAY A BARE TEXT NODE.                                     │
 * │                                                                           │
 * │ scripts/render-check.mjs asserts on `>Label<` patterns rather than         │
 * │ `includes('Label')`, because next-intl serialises the whole message bundle │
 * │ into every page and `includes` is therefore always true. Putting an icon   │
 * │ or a <span> between the h1's `>` and the first character of the title      │
 * │ silently breaks sixteen assertions. An icon in `actions`, or as a          │
 * │ PRECEDING sibling, is fine.                                               │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  actions?: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('flex flex-wrap items-start justify-between gap-3', className)}>
      <div className="min-w-0 space-y-1">
        {/* The role, not a respelling of it. `text-2xl font-semibold tracking-tight`
            was the mobile half of this role applied at every width, so every page
            title in the product was rendering one step small on a desktop.
            text-headline-lg carries its own `width < 48rem` size, so the phone
            keeps exactly what it had. */}
        <h1 className="font-heading text-headline-lg text-balance">{title}</h1>
        {description && (
          <p className="max-w-prose text-body-sm text-pretty text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      {/*
          shrink-0 keeps the buttons from being squashed beside a long title —
          correct at desktop width, and the reason a 320px header overflowed by
          69px: a flex item that cannot shrink sizes to the whole row of
          buttons laid end to end, so its own flex-wrap never engages.

          Below md it takes the full width instead, drops under the title, and
          wraps its buttons the way it was always meant to.
      */}
      {actions && (
        <div className="flex shrink-0 flex-wrap items-center gap-2 max-md:w-full max-md:shrink">
          {actions}
        </div>
      )}
    </div>
  )
}
