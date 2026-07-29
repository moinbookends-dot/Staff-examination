import { DownloadIcon } from 'lucide-react'
import { buttonVariants } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * A link to the CSV export route.
 *
 * A plain `<a>`, deliberately. `next/link` is for client-side navigation
 * between app routes; this points at a route handler that answers with
 * `Content-Disposition: attachment`, and prefetching or soft-navigating to a
 * file download is wrong in both directions.
 *
 * (`@next/next/no-html-link-for-pages` fires on a static literal href and not
 * on an interpolated one, which is why the identical code in team-sections.tsx
 * never tripped it. That is a quirk of the rule, not a reason to keep two
 * copies — so this is the one copy.)
 *
 * The route re-checks `reports.export` itself, so the `canExport` gate at each
 * call site is presentation only.
 */
export function ExportLink({
  dataset,
  label,
  className,
}: {
  dataset: 'team' | 'exams' | 'questions'
  label: string
  className?: string
}) {
  return (
    <a
      href={`/api/reports/export?dataset=${dataset}`}
      className={cn(buttonVariants({ variant: 'outline', size: 'sm' }), className)}
    >
      <DownloadIcon className="size-4" />
      {label}
    </a>
  )
}
