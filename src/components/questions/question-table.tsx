'use client'

import { useCallback, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Link, useRouter } from '@/lib/i18n/navigation'
import { filtersToSearchParams } from '@/lib/search-params'
import {
  QUESTION_URL_DEFAULTS,
  type QuestionSortColumn,
  type SortDirection,
} from '@/lib/questions/sort'
import type { QuestionListItem } from '@/server/actions/questions'
import { useQuestionSelection } from './selection-provider'
import { QuestionHealthBadges } from './health-badges'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { cn } from '@/lib/utils'
import { ArrowDownIcon, ArrowUpIcon, ChevronsUpDownIcon } from 'lucide-react'

/**
 * The question bank's grid.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHY THIS DOES NOT USE components/ui/table.tsx.                            │
 * │                                                                           │
 * │ That component wraps every table in                                       │
 * │   <div className="relative w-full overflow-x-auto">                       │
 * │ and exposes no className or ref for it. In CSS, `overflow-x: auto` forces │
 * │ `overflow-y` to compute to `auto` as well — so that div becomes the       │
 * │ nearest scrollport, it has no height, it never scrolls, and a sticky      │
 * │ <thead> inside it sticks to nothing at all. The header would scroll away  │
 * │ on a 200-row page, which is the one place a header has to stay.           │
 * │                                                                           │
 * │ Forking table.tsx is not the answer either: it is installed and managed   │
 * │ by the shadcn CLI, so the next `shadcn add table` silently reverts the    │
 * │ fork. Instead this owns its container, bounds it with max-h so it is a    │
 * │ genuine scrollport in BOTH axes, and sticks the header inside that.       │
 * │ table.tsx is untouched and still serves the simple lists.                 │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ NO BUSINESS LOGIC LIVES HERE.                                             │
 * │                                                                           │
 * │ Sorting is a URL parameter the server validates against an allowlist.     │
 * │ Health badges are rendered from `item.health`, computed once in           │
 * │ questionHealth(). Which actions a row offers is decided by the            │
 * │ permissions the server passed down, and every action re-checks them and   │
 * │ runs under RLS regardless. This file decides what things look like.       │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

/** Column identity. `sort` names the server-side column, when sortable. */
interface Column {
  id: string
  sort?: QuestionSortColumn
  /** Rendered right-aligned. Numeric columns set it. */
  numeric?: boolean
  /** Hidden by default — shown only if the user turns it on. */
  optional?: boolean
  width: string
}

export const QUESTION_COLUMNS: readonly Column[] = [
  { id: 'question', sort: 'stem', width: 'minmax(20rem, 2fr)' },
  { id: 'status', sort: 'status', width: '8rem' },
  { id: 'health', width: '12rem' },
  { id: 'type', sort: 'type', width: '9rem' },
  { id: 'category', width: '10rem' },
  { id: 'difficulty', sort: 'difficulty', numeric: true, width: '6rem' },
  { id: 'bloom', sort: 'bloom_level', width: '8rem' },
  { id: 'translations', width: '8rem' },
  { id: 'source', sort: 'source', width: '7rem' },
  { id: 'importedFrom', optional: true, width: '8rem' },
  { id: 'marks', numeric: true, width: '5rem' },
  { id: 'usage', sort: 'usage_count', numeric: true, width: '7rem' },
  { id: 'revision', sort: 'revision', numeric: true, optional: true, width: '5rem' },
  { id: 'updatedAt', sort: 'updated_at', width: '8rem' },
  { id: 'createdBy', optional: true, width: '10rem' },
  { id: 'updatedBy', optional: true, width: '10rem' },
]

/**
 * Which columns are on, and how wide.
 *
 * localStorage, not the database. These are per-device by nature and a resize
 * changes on every mouse-move — persisting that to Postgres would be a write
 * per frame to store a number nobody else will ever read. Saved filters are a
 * table (0043) because they are content; this is furniture.
 *
 * The key carries the column set, so adding a column cannot resurrect a layout
 * that predates it and silently leave the new column hidden forever.
 */
const LAYOUT_KEY = `bookends.questions.layout.v1.${QUESTION_COLUMNS.map((c) => c.id).join('-')}`

interface Layout {
  hidden: string[]
  widths: Record<string, number>
}

/**
 * Read through useSyncExternalStore, not useState + useEffect.
 *
 * Reading localStorage during render would make the server's markup disagree
 * with the browser's; the usual dodge — empty state, then setState in an
 * effect — is what React's lint rule rejects, and here it would also render
 * one frame with every optional column visible before hiding them again.
 *
 * Same shape as selection-provider.tsx, deliberately: two stores in one screen
 * behaving differently is how one of them ends up subtly wrong.
 */
const DEFAULT_LAYOUT: Layout = {
  hidden: QUESTION_COLUMNS.filter((c) => c.optional).map((c) => c.id),
  widths: {},
}
/** What the server renders, and the first client frame: no columns hidden. */
const SERVER_LAYOUT: Layout = { hidden: [], widths: {} }

let cachedRaw: string | null = null
let cachedLayout: Layout = DEFAULT_LAYOUT
let fallbackRaw: string | null = null
const listeners = new Set<() => void>()

function layoutSnapshot(): Layout {
  let raw: string | null
  try {
    raw = localStorage.getItem(LAYOUT_KEY)
  } catch {
    raw = fallbackRaw
  }
  if (raw === cachedRaw) return cachedLayout
  cachedRaw = raw
  if (!raw) {
    cachedLayout = DEFAULT_LAYOUT
    return cachedLayout
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Layout>
    cachedLayout = {
      hidden: Array.isArray(parsed.hidden) ? parsed.hidden.filter((v) => typeof v === 'string') : [],
      widths: typeof parsed.widths === 'object' && parsed.widths ? parsed.widths : {},
    }
  } catch {
    cachedLayout = DEFAULT_LAYOUT
  }
  return cachedLayout
}

const serverLayoutSnapshot = (): Layout => SERVER_LAYOUT

function subscribeLayout(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function writeLayout(next: Layout): void {
  const raw = JSON.stringify(next)
  fallbackRaw = raw
  try {
    localStorage.setItem(LAYOUT_KEY, raw)
  } catch {
    // Private browsing or a full quota. The layout applies for this page and
    // will not survive a reload — nothing the user could act on.
  }
  for (const listener of listeners) listener()
}

export function QuestionTable({
  items,
  canSelect,
}: {
  items: QuestionListItem[]
  /** False for anyone who cannot act on a selection — no point offering one. */
  canSelect: boolean
}) {
  const t = useTranslations('questions')
  const tTypes = useTranslations('questions.types')
  const tBloom = useTranslations('questions.bloom')
  const tSource = useTranslations('questions.source')
  const router = useRouter()
  const params = useSearchParams()
  const selection = useQuestionSelection()

  const layout = useSyncExternalStore(subscribeLayout, layoutSnapshot, serverLayoutSnapshot)
  const [focused, setFocused] = useState(0)
  const bodyRef = useRef<HTMLTableSectionElement>(null)
  /** Anchor for Shift+click. Null until a row has been clicked normally. */
  const anchor = useRef<number | null>(null)

  const persist = writeLayout

  const visible = useMemo(
    () => QUESTION_COLUMNS.filter((c) => !layout.hidden.includes(c.id)),
    [layout.hidden],
  )

  const sort = (params.get('sort') ?? QUESTION_URL_DEFAULTS.sort) as QuestionSortColumn
  const dir = (params.get('dir') ?? QUESTION_URL_DEFAULTS.dir) as SortDirection

  /**
   * Sorting uses replace, not push. Sorting a table four times to find what
   * you want should not cost four presses of Back to leave the page. Filters
   * keep push, which is a deliberate existing decision — a filter change is a
   * different question being asked, a sort is the same question re-read.
   */
  const applySort = useCallback(
    (column: QuestionSortColumn) => {
      const next = {
        ...Object.fromEntries(params.entries()),
        sort: column,
        dir: sort === column && dir === 'desc' ? 'asc' : 'desc',
        page: '1',
      }
      router.replace(`/questions?${filtersToSearchParams(next, QUESTION_URL_DEFAULTS)}`)
    },
    [params, router, sort, dir],
  )

  const pageIds = useMemo(() => items.map((item) => item.id), [items])
  const allOnPageSelected = pageIds.length > 0 && pageIds.every((id) => selection.isSelected(id))

  const toggleRow = useCallback(
    (index: number, shiftKey: boolean) => {
      const id = pageIds[index]
      if (!id) return
      if (shiftKey && anchor.current !== null) {
        const [lo, hi] = [anchor.current, index].sort((a, b) => a - b)
        selection.selectMany(pageIds.slice(lo, hi + 1))
        return
      }
      anchor.current = index
      selection.toggle(id)
    },
    [pageIds, selection],
  )

  /**
   * Keyboard navigation, scoped to the table.
   *
   * On the table element rather than the document: a global listener would
   * make `j` unusable in the search box on the same screen, and this codebase
   * has no shortcut registry to arbitrate between two of them. The guard below
   * is still needed because the table contains checkboxes and links.
   */
  const onKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTableElement>) => {
      const target = event.target as HTMLElement
      if (
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable
      ) {
        return
      }

      const move = (to: number) => {
        const clamped = Math.max(0, Math.min(items.length - 1, to))
        setFocused(clamped)
        const row = bodyRef.current?.children[clamped] as HTMLElement | undefined
        row?.focus()
        event.preventDefault()
      }

      switch (event.key) {
        case 'j':
        case 'ArrowDown':
          return move(focused + 1)
        case 'k':
        case 'ArrowUp':
          return move(focused - 1)
        case 'Home':
          return move(0)
        case 'End':
          return move(items.length - 1)
        case 'x':
        case ' ':
          if (!canSelect) return
          toggleRow(focused, event.shiftKey)
          event.preventDefault()
          return
        case 'a':
          if (!canSelect || !(event.ctrlKey || event.metaKey)) return
          selection.selectMany(pageIds)
          event.preventDefault()
          return
        case 'Escape':
          selection.clear()
          return
        default:
      }
    },
    [focused, items.length, canSelect, toggleRow, selection, pageIds],
  )

  const headerFor = (column: Column) =>
    column.id === 'usage' ? t('columns.usage') : t(`columns.${column.id}`)

  return (
    <div className="rounded-lg border">
      {/*
       * The scrollport. Bounded height is what makes `sticky` work at all —
       * see the note at the top of this file. `top-0` and not the app's usual
       * `top-14` because the header sticks to THIS box, not to the viewport.
       */}
      <div className="max-h-[calc(100svh-19rem)] min-h-40 overflow-auto">
        <table
          className="w-full border-collapse text-sm"
          onKeyDown={onKeyDown}
          // The table names itself for a screen reader, which otherwise
          // announces "table with 16 columns" and nothing about what is in it.
          aria-label={t('title')}
        >
          {/*
           * Widths via colgroup: one style property per column rather than a
           * style prop on every cell of every row. At 100 rows and 16 columns
           * that is 16 declarations instead of 1,600.
           */}
          <colgroup>
            {canSelect && <col style={{ width: '2.75rem' }} />}
            {visible.map((column) => (
              <col
                key={column.id}
                style={{ width: layout.widths[column.id] ? `${layout.widths[column.id]}px` : column.width }}
              />
            ))}
          </colgroup>

          <thead className="sticky top-0 z-10 bg-muted/95 backdrop-blur">
            <tr>
              {canSelect && (
                <th scope="col" className="px-2 py-2">
                  <Checkbox
                    checked={allOnPageSelected}
                    onCheckedChange={() =>
                      allOnPageSelected
                        ? selection.deselectMany(pageIds)
                        : selection.selectMany(pageIds)
                    }
                    aria-label={t('bulk.selectAllRows')}
                  />
                </th>
              )}
              {visible.map((column) => (
                <th
                  key={column.id}
                  scope="col"
                  // aria-sort belongs on the header CELL, not the button, and
                  // only the sorted one may carry it — 'none' on every other
                  // column is valid but makes a screen reader read the sort
                  // state of sixteen columns to find the one that has it.
                  aria-sort={
                    column.sort && sort === column.sort
                      ? dir === 'asc'
                        ? 'ascending'
                        : 'descending'
                      : undefined
                  }
                  className={cn(
                    'relative border-b px-2 py-2 text-left align-middle font-medium text-muted-foreground',
                    column.numeric && 'text-right',
                  )}
                >
                  {column.sort ? (
                    <button
                      type="button"
                      onClick={() => applySort(column.sort!)}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-sm hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                        column.numeric && 'flex-row-reverse',
                      )}
                    >
                      {headerFor(column)}
                      {sort === column.sort ? (
                        dir === 'asc' ? (
                          <ArrowUpIcon className="size-3.5" aria-hidden />
                        ) : (
                          <ArrowDownIcon className="size-3.5" aria-hidden />
                        )
                      ) : (
                        <ChevronsUpDownIcon className="size-3.5 opacity-40" aria-hidden />
                      )}
                      {/*
                       * The state in words. The icon alone is invisible to a
                       * screen reader, and aria-label on the button would
                       * REPLACE the column name rather than add to it — the
                       * mistake that hid the exam countdown's value.
                       */}
                      <span className="sr-only">
                        {sort === column.sort
                          ? dir === 'asc'
                            ? t('sort.ascending')
                            : t('sort.descending')
                          : t('sort.none')}
                      </span>
                    </button>
                  ) : (
                    headerFor(column)
                  )}

                  {/* Resize handle. Pointer-only by design — a keyboard user
                      gets column visibility instead, which achieves the same
                      goal (see the width they care about) without asking them
                      to drag anything. */}
                  <span
                    role="presentation"
                    onPointerDown={(event) => {
                      const th = event.currentTarget.parentElement as HTMLElement
                      const startX = event.clientX
                      const startWidth = th.getBoundingClientRect().width
                      const onMove = (move: PointerEvent) => {
                        const width = Math.max(56, startWidth + move.clientX - startX)
                        persist({
                          ...layout,
                          widths: { ...layout.widths, [column.id]: Math.round(width) },
                        })
                      }
                      const onUp = () => {
                        window.removeEventListener('pointermove', onMove)
                        window.removeEventListener('pointerup', onUp)
                      }
                      window.addEventListener('pointermove', onMove)
                      window.addEventListener('pointerup', onUp)
                    }}
                    className="absolute top-0 right-0 h-full w-1 cursor-col-resize select-none hover:bg-border"
                  />
                </th>
              ))}
            </tr>
          </thead>

          <tbody ref={bodyRef}>
            {items.map((item, index) => {
              const selected = selection.isSelected(item.id)
              return (
                <tr
                  key={item.id}
                  // Roving tabindex: the table is ONE tab stop, not sixteen per
                  // row. Tabbing through a 100-row grid otherwise takes 1,600
                  // presses to get past.
                  tabIndex={index === focused ? 0 : -1}
                  onFocus={() => setFocused(index)}
                  aria-selected={canSelect ? selected : undefined}
                  data-state={selected ? 'selected' : undefined}
                  className={cn(
                    'border-b transition-colors last:border-0',
                    selected ? 'bg-primary/8' : 'hover:bg-muted/50',
                    'focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                  )}
                >
                  {canSelect && (
                    <td className="px-2 py-2 align-middle">
                      <Checkbox
                        checked={selected}
                        onClick={(event) => toggleRow(index, event.shiftKey)}
                        aria-label={t('bulk.selectRow')}
                      />
                    </td>
                  )}

                  {visible.map((column) => (
                    <td
                      key={column.id}
                      className={cn(
                        'px-2 py-2 align-middle',
                        column.numeric && 'text-right tabular-nums',
                        // Everything except the stem stays on one line. The
                        // stem wraps, which is the whole complaint data-table's
                        // docblock records against table.tsx's blanket
                        // whitespace-nowrap.
                        column.id !== 'question' && 'whitespace-nowrap',
                      )}
                    >
                      <Cell
                        column={column}
                        item={item}
                        t={t}
                        tTypes={tTypes}
                        tBloom={tBloom}
                        tSource={tSource}
                      />
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <ColumnVisibility layout={layout} persist={persist} />
    </div>
  )
}

type Translate = ReturnType<typeof useTranslations>

function Cell({
  column,
  item,
  t,
  tTypes,
  tBloom,
  tSource,
}: {
  column: Column
  item: QuestionListItem
  t: Translate
  tTypes: Translate
  tBloom: Translate
  tSource: Translate
}) {
  switch (column.id) {
    case 'question':
      return (
        <Link
          href={`/questions/${item.id}`}
          className="font-medium underline-offset-4 hover:underline"
        >
          {item.stem}
        </Link>
      )
    case 'status':
      return (
        <Badge variant={item.status === 'active' ? 'default' : 'secondary'}>
          {t(`status.${item.status}`)}
        </Badge>
      )
    case 'health':
      return <QuestionHealthBadges health={item.health} />
    case 'type':
      return <span className="text-muted-foreground">{tTypes(item.type)}</span>
    case 'category':
      return <span className="text-muted-foreground">{item.category_name ?? '—'}</span>
    case 'difficulty':
      return item.difficulty
    case 'bloom':
      return (
        <span className="text-muted-foreground">
          {item.bloom_level ? tBloom(item.bloom_level) : '—'}
        </span>
      )
    case 'translations':
      return item.translated_locales.length === 0 ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <span className="text-muted-foreground uppercase">
          {[...item.translated_locales].sort().join(' · ')}
        </span>
      )
    case 'source':
      // 'manual' is the overwhelming majority and carries no badge: badging
      // every row makes the exceptions harder to see, not easier.
      return item.source === 'manual' ? (
        <span className="text-muted-foreground">—</span>
      ) : (
        <Badge variant={item.source === 'ai' ? 'info' : 'secondary'}>{tSource(item.source)}</Badge>
      )
    case 'importedFrom':
      return <span className="text-muted-foreground">{item.imported_from ?? '—'}</span>
    case 'marks':
      return item.marks
    case 'usage':
      // Titled, not just numbered. The figure counts fixed-paper placements
      // only — publish_exam is its one writer and rule-based exams never touch
      // it — so an unexplained 0 next to a heavily used question reads as a bug.
      return <span title={t('usageHint')}>{item.usage_count}</span>
    case 'revision':
      return <span className="text-muted-foreground">{item.revision}</span>
    case 'updatedAt':
      return (
        <time dateTime={item.updated_at} className="text-muted-foreground">
          {item.updated_at.slice(0, 10)}
        </time>
      )
    case 'createdBy':
      return (
        <span className="text-muted-foreground">
          {item.created_by_name ?? t('unknownAuthor')}
        </span>
      )
    case 'updatedBy':
      return (
        <span className="text-muted-foreground">
          {item.updated_by_name ?? t('unknownAuthor')}
        </span>
      )
    default:
      return null
  }
}

function ColumnVisibility({
  layout,
  persist,
}: {
  layout: Layout
  persist: (next: Layout) => void
}) {
  const t = useTranslations('questions')

  return (
    <details className="border-t px-3 py-2 text-sm">
      <summary className="cursor-pointer text-muted-foreground select-none">
        {t('columnsMenu.label')}
      </summary>
      {/*
       * Plain checkboxes in a fieldset rather than a dropdown menu. A menu
       * closes on every choice, so turning three columns off is three trips
       * through it — and this is the one control where people change several
       * things at once.
       */}
      <fieldset className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
        <legend className="sr-only">{t('columnsMenu.label')}</legend>
        {QUESTION_COLUMNS.map((column) => {
          const shown = !layout.hidden.includes(column.id)
          return (
            <label key={column.id} className="flex items-center gap-1.5">
              <input
                type="checkbox"
                checked={shown}
                onChange={() =>
                  persist({
                    ...layout,
                    hidden: shown
                      ? [...layout.hidden, column.id]
                      : layout.hidden.filter((id) => id !== column.id),
                  })
                }
                className="size-3.5 accent-primary"
              />
              <span className="text-muted-foreground">{t(`columns.${column.id}`)}</span>
            </label>
          )
        })}
      </fieldset>
    </details>
  )
}
