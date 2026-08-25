import { describe, it, expect } from 'vitest'
import {
  excludedItemIds,
  filterItemsBySearch,
  itemsNeedingChange,
  partitionByUsage,
  type SelectableItem,
} from '@/lib/papers/item-selection'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The recipe/item selector, and the one press that cannot be taken back.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THE PROPERTY THIS FILE EXISTS FOR: a bulk action must touch ONLY what the ║
 * ║ search is showing.                                                        ║
 * ║                                                                           ║
 * ║ "Stop using all shown" withdraws dishes from every future paper in a      ║
 * ║ single press. If it ever read the whole pool instead of the filtered      ║
 * ║ view, searching "pizza" and pressing it would quietly withdraw the entire ║
 * ║ menu — a destructive change that looks, on screen, like it did the narrow ║
 * ║ thing that was asked. Nothing about the rendered output would reveal it.  ║
 * ║                                                                           ║
 * ║ The dish names are the real ones from the bank so a failure reads like    ║
 * ║ the product. What is asserted is the rule, not the data.                  ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */

const pool: SelectableItem[] = [
  { id: 'i-margherita', name: 'Pizza Margherita', inUse: true },
  { id: 'i-hulk', name: 'Hulk', inUse: true },
  { id: 'i-truffle-pasta', name: 'Truffle Pasta', inUse: true },
  { id: 'i-burnt-garlic', name: 'Burnt Garlic Fried Rice', inUse: false },
  { id: 'i-mushroom', name: 'Mushroom Truffle Fried Rice', inUse: true },
  { id: 'i-pizza-bianca', name: 'Pizza Bianca', inUse: false },
  // The synthetic bucket for questions naming no known dish. No row in
  // bank_items, so no id — every write path must step over it.
  { id: null, name: 'No recipe', inUse: true },
]

describe('searching the item list', () => {
  it('finds a dish by a lower-case fragment of its name', () => {
    expect(filterItemsBySearch(pool, 'hulk').map((i) => i.name)).toEqual(['Hulk'])
  })

  it('is case-insensitive in both directions', () => {
    expect(filterItemsBySearch(pool, 'HULK').map((i) => i.name)).toEqual(['Hulk'])
    expect(filterItemsBySearch(pool, 'hUlK').map((i) => i.name)).toEqual(['Hulk'])
  })

  it('matches anywhere in the name, not only the start', () => {
    // "Truffle" is mid-name in one and leading in the other; both must match,
    // or a chef searching a key ingredient sees half the dishes that use it.
    expect(filterItemsBySearch(pool, 'truffle').map((i) => i.name)).toEqual([
      'Truffle Pasta',
      'Mushroom Truffle Fried Rice',
    ])
  })

  it('returns several matches for a shared word', () => {
    expect(filterItemsBySearch(pool, 'pizza').map((i) => i.name)).toEqual([
      'Pizza Margherita',
      'Pizza Bianca',
    ])
  })

  it('shows the whole pool when the box is empty', () => {
    expect(filterItemsBySearch(pool, '')).toHaveLength(pool.length)
  })

  it('shows the whole pool for a query that is only whitespace', () => {
    // A stray space is not a filter. Blanking the list on one would read as
    // "there are no recipes".
    expect(filterItemsBySearch(pool, '   ')).toHaveLength(pool.length)
  })

  it('ignores surrounding whitespace on a real query', () => {
    expect(filterItemsBySearch(pool, '  hulk  ').map((i) => i.name)).toEqual(['Hulk'])
  })

  it('returns nothing for a dish that is not on the menu', () => {
    expect(filterItemsBySearch(pool, 'lasagne')).toEqual([])
  })

  it('does not mutate or alias the pool it was given', () => {
    const before = [...pool]
    const out = filterItemsBySearch(pool, '')
    out.pop()
    expect(pool).toEqual(before)
  })
})

describe('the two headings', () => {
  it('splits the pool into in-use and not-in-use', () => {
    const { inUse, notInUse } = partitionByUsage(pool)
    expect(inUse.map((i) => i.name)).toEqual([
      'Pizza Margherita',
      'Hulk',
      'Truffle Pasta',
      'Mushroom Truffle Fried Rice',
      'No recipe',
    ])
    expect(notInUse.map((i) => i.name)).toEqual(['Burnt Garlic Fried Rice', 'Pizza Bianca'])
  })

  it('accounts for every item exactly once', () => {
    const { inUse, notInUse } = partitionByUsage(pool)
    expect(inUse.length + notInUse.length).toBe(pool.length)
  })

  it('groups the search results, not the whole pool, when given them', () => {
    // What the panel renders under the two headings is the SHOWN list.
    const shown = filterItemsBySearch(pool, 'pizza')
    const { inUse, notInUse } = partitionByUsage(shown)
    expect(inUse.map((i) => i.name)).toEqual(['Pizza Margherita'])
    expect(notInUse.map((i) => i.name)).toEqual(['Pizza Bianca'])
  })
})

describe('"Stop using all shown" and "Use all shown"', () => {
  it('changes only the dishes the search is showing', () => {
    const shown = filterItemsBySearch(pool, 'pizza')
    const changing = itemsNeedingChange(shown, false)

    // Margherita is in use and shown, so it changes. Bianca is already
    // withdrawn. Nothing else is on screen and nothing else may be touched.
    expect(changing.map((i) => i.name)).toEqual(['Pizza Margherita'])
  })

  it('never reaches a dish outside the search, however many match', () => {
    const shown = filterItemsBySearch(pool, 'pizza')
    const changing = itemsNeedingChange(shown, false)
    const touched = new Set(changing.map((i) => i.id))

    for (const item of pool) {
      if (!shown.includes(item)) {
        expect(touched.has(item.id)).toBe(false)
      }
    }
  })

  it('withdraws every shown dish that is still in use', () => {
    const shown = filterItemsBySearch(pool, 'rice')
    expect(itemsNeedingChange(shown, false).map((i) => i.name)).toEqual([
      'Mushroom Truffle Fried Rice',
    ])
  })

  it('restores every shown dish that is currently withdrawn', () => {
    const shown = filterItemsBySearch(pool, 'pizza')
    expect(itemsNeedingChange(shown, true).map((i) => i.name)).toEqual(['Pizza Bianca'])
  })

  it('writes nothing when everything shown is already in the target state', () => {
    // One write per press is the difference between a no-op and ninety
    // pointless round-trips.
    const shown = filterItemsBySearch(pool, 'hulk')
    expect(itemsNeedingChange(shown, true)).toEqual([])
  })

  it('skips the synthetic "no recipe" bucket, which has no row to write', () => {
    const all = itemsNeedingChange(pool, false)
    expect(all.every((i) => i.id !== null)).toBe(true)
    expect(all.map((i) => i.name)).not.toContain('No recipe')
  })

  it('over the unfiltered pool, still only reports genuine changes', () => {
    expect(itemsNeedingChange(pool, false).map((i) => i.name)).toEqual([
      'Pizza Margherita',
      'Hulk',
      'Truffle Pasta',
      'Mushroom Truffle Fried Rice',
    ])
  })
})

describe('what a generation request excludes', () => {
  it('lists every withdrawn dish that has an id', () => {
    expect(excludedItemIds(pool)).toEqual(['i-burnt-garlic', 'i-pizza-bianca'])
  })

  it('is unaffected by what the search box happens to contain', () => {
    /*
     * The regression this guards: deriving the exclusion list from the SHOWN
     * items. Type "pizza" into the box and Burnt Garlic Fried Rice — withdrawn
     * minutes earlier — would silently return to the candidate pool, because
     * it is not on screen. The list must come from the whole pool.
     */
    const fromWholePool = excludedItemIds(pool)
    const shown = filterItemsBySearch(pool, 'pizza')
    expect(excludedItemIds(shown)).toEqual(['i-pizza-bianca'])
    expect(fromWholePool).toContain('i-burnt-garlic')
  })

  it('never includes the synthetic bucket, which is governed separately', () => {
    const withdrawnNoRecipe: SelectableItem[] = [{ id: null, name: 'No recipe', inUse: false }]
    expect(excludedItemIds(withdrawnNoRecipe)).toEqual([])
  })

  it('is empty when the whole menu is in use', () => {
    expect(excludedItemIds(pool.map((i) => ({ ...i, inUse: true })))).toEqual([])
  })
})
