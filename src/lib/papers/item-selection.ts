/**
 * The recipe/item selector's decisions, as pure functions.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHY THIS FILE EXISTS AT ALL.                                              │
 * │                                                                           │
 * │ These four rules used to live inline in generate-panel.tsx, which has no  │
 * │ test: the project installs no DOM testing library, so anything expressed  │
 * │ only as JSX is unreachable from the unit suite.                           │
 * │                                                                           │
 * │ The rule that most needs a test is the scoping of the bulk actions.       │
 * │ "Stop using all shown" is destructive and irreversible in one press, and  │
 * │ its correctness rests entirely on operating over the SEARCH RESULTS       │
 * │ rather than the whole pool — search "pizza", press it, and the other      │
 * │ eighty-odd dishes must be untouched. That is a property worth asserting   │
 * │ rather than trusting to a closure over the right variable.                │
 * │                                                                           │
 * │ Extracted verbatim. Same behaviour, now addressable by a test.            │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

/** The shape the generate panel holds for each recipe/item. */
export interface SelectableItem {
  /** null is the synthetic "questions naming no known dish" bucket. */
  id: string | null
  name: string
  inUse: boolean
}

/**
 * The items a search box is currently showing.
 *
 * An empty or whitespace-only query shows everything — the selector opens with
 * no filter, and a stray space must not blank the list. Matching is
 * case-insensitive and substring-based, so "hulk" finds "Hulk" and "pizza"
 * finds "Pizza Margherita".
 */
export function filterItemsBySearch<T extends SelectableItem>(pool: readonly T[], search: string): T[] {
  const needle = search.trim().toLowerCase()
  if (!needle) return [...pool]
  return pool.filter((item) => item.name.toLowerCase().includes(needle))
}

/**
 * Split into the two headings the panel renders.
 *
 * Two groups rather than one list with strikethrough: a withdrawn dish is a
 * decision somebody made and may need to undo, and finding it among ninety
 * that are fine is the hard part.
 */
export function partitionByUsage<T extends SelectableItem>(
  items: readonly T[],
): { inUse: T[]; notInUse: T[] } {
  return {
    inUse: items.filter((i) => i.inUse),
    notInUse: items.filter((i) => !i.inUse),
  }
}

/**
 * Which items a bulk action would actually write.
 *
 * Two filters, and both matter:
 *
 *   · already in the target state → skipped, so pressing "Use all shown" when
 *     nine of ten are already in use is one write rather than ten.
 *   · id === null → skipped, because the "names no known dish" bucket is
 *     synthetic. It has no row in bank_items and is governed by the separate
 *     includeNoItem flag; writing to it would mean inventing a primary key.
 *
 * The caller passes the SHOWN items, never the whole pool. That is the entire
 * safety property of the bulk actions and the reason this takes a list rather
 * than reaching for one itself.
 */
export function itemsNeedingChange<T extends SelectableItem>(
  shown: readonly T[],
  inUse: boolean,
): T[] {
  return shown.filter((item) => item.id !== null && item.inUse !== inUse)
}

/**
 * The ids a generation request must exclude.
 *
 * Derived from the WHOLE pool, never from the search results — what is on
 * screen is a view, and a dish withdrawn earlier stays withdrawn while you are
 * searching for something else. Getting this one wrong would silently
 * re-admit withdrawn recipes to a paper whenever the box had text in it.
 */
export function excludedItemIds(pool: readonly SelectableItem[]): string[] {
  return pool.filter((i) => !i.inUse && i.id !== null).map((i) => i.id as string)
}
