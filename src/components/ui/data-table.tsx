import { Fragment } from 'react'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * A table above `md`, a stack of cards below it.
 *
 * WHY THIS IS NOT JUST A SCROLLING TABLE.
 *
 * table.tsx hard-codes `whitespace-nowrap` on both TableHead and TableCell, and
 * Card carries `overflow-hidden`. A seven-column table on a 375px phone
 * therefore scrolls horizontally INSIDE a container that clips the scrollbar,
 * so the affordance telling you there is more to the right is invisible. Four
 * of the seven columns simply do not exist as far as the reader is concerned.
 *
 * Restaurant staff are overwhelmingly on phones. A list they cannot read is
 * not a styling problem.
 *
 * Both forms render, and one is hidden by CSS. That does mean every cell's
 * text appears twice in the HTML — deliberate, and safe for the render check,
 * which asserts that a string is present, never how many times. It is NOT safe
 * for any assertion that slices the document between two markers and reads
 * what is in between; /results does that, which is one reason /results keeps
 * its hand-built cards.
 * ═══════════════════════════════════════════════════════════════════════════
 */

export interface DataTableColumn<T> {
  /** Stable identity for React keys. */
  id: string
  header: React.ReactNode
  cell: (row: T) => React.ReactNode
  /** Right-aligns the column in the table. Numeric columns should set this. */
  align?: 'end'
  /**
   * On mobile this becomes the card's title instead of a label/value pair.
   * Exactly one column should set it.
   */
  primary?: boolean
  /** On mobile this is pinned to the card's top-right — status pills go here. */
  trailing?: boolean
  /** Dropped from the card entirely. For columns that only make sense in a grid. */
  cardHidden?: boolean
  className?: string
  headClassName?: string
}

export function DataTable<T>({
  rows,
  columns,
  rowKey,
  empty,
  caption,
  className,
}: {
  rows: readonly T[]
  columns: readonly DataTableColumn<T>[]
  rowKey: (row: T) => string
  /** Rendered instead of both forms when there is nothing to show. */
  empty?: React.ReactNode
  /** Visually hidden, but read out — tables want a name. */
  caption?: string
  className?: string
}) {
  if (rows.length === 0) return <>{empty}</>

  const primary = columns.find((c) => c.primary)
  const trailing = columns.filter((c) => c.trailing)
  const detail = columns.filter((c) => !c.primary && !c.trailing && !c.cardHidden)

  return (
    <div className={className}>
      {/* ── Table: md and up ─────────────────────────────────────────────── */}
      <div className="hidden md:block">
        <Table>
          {caption && <caption className="sr-only">{caption}</caption>}
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {columns.map((column) => (
                <TableHead
                  key={column.id}
                  className={cn(
                    'text-xs font-medium tracking-wide text-muted-foreground uppercase',
                    column.align === 'end' && 'text-right',
                    column.headClassName,
                  )}
                >
                  {column.header}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={rowKey(row)}>
                {columns.map((column) => (
                  <TableCell
                    key={column.id}
                    className={cn(
                      column.align === 'end' && 'text-right tabular-nums',
                      column.className,
                    )}
                  >
                    {column.cell(row)}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {/* ── Cards: below md ──────────────────────────────────────────────── */}
      <ul className="flex flex-col gap-3 md:hidden">
        {rows.map((row) => (
          <li
            key={rowKey(row)}
            className="rounded-xl border bg-card/40 p-3 text-sm ring-1 ring-foreground/5"
          >
            <div className="flex items-start justify-between gap-2">
              {primary && <div className="min-w-0 font-medium">{primary.cell(row)}</div>}
              {trailing.length > 0 && (
                <div className="flex shrink-0 items-center gap-1.5">
                  {trailing.map((column) => (
                    <Fragment key={column.id}>{column.cell(row)}</Fragment>
                  ))}
                </div>
              )}
            </div>

            {detail.length > 0 && (
              <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 border-t pt-3">
                {detail.map((column) => (
                  <div key={column.id} className="min-w-0">
                    <dt className="text-[0.7rem] tracking-wide text-muted-foreground uppercase">
                      {column.header}
                    </dt>
                    <dd className="truncate tabular-nums">{column.cell(row)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
