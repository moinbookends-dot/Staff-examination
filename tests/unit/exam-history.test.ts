import { describe, it, expect } from 'vitest'
import {
  canRedo,
  canUndo,
  HISTORY_LIMIT,
  initHistory,
  moveItem,
  record,
  redo,
  undo,
} from '../../src/lib/exams/history'

/**
 * Undo/redo for the paper builder.
 *
 * Tested here rather than through the component because it is pure: the
 * interesting behaviour is coalescing and branch-abandonment, and neither is
 * easier to see through a DOM.
 */

describe('history', () => {
  it('starts with nothing to undo or redo', () => {
    const h = initHistory({ n: 1 })
    expect(canUndo(h)).toBe(false)
    expect(canRedo(h)).toBe(false)
  })

  it('undoes and redoes a single change', () => {
    let h = initHistory({ n: 1 })
    h = record(h, { n: 2 })
    expect(h.present).toEqual({ n: 2 })

    h = undo(h)
    expect(h.present).toEqual({ n: 1 })
    expect(canRedo(h)).toBe(true)

    h = redo(h)
    expect(h.present).toEqual({ n: 2 })
  })

  /**
   * The behaviour the whole file exists for. Every keystroke in a section
   * title is a state change; without coalescing, Undo removes one letter and a
   * chef presses it forty times to get back to where they were.
   */
  it('collapses consecutive edits that share a label', () => {
    let h = initHistory({ title: '' })
    for (const title of ['P', 'Pi', 'Piz', 'Pizz', 'Pizza']) {
      h = record(h, { title }, 'title:s1')
    }
    expect(h.present).toEqual({ title: 'Pizza' })

    h = undo(h)
    // All the way back to empty, not to 'Pizz'.
    expect(h.present).toEqual({ title: '' })
    expect(canUndo(h)).toBe(false)
  })

  it('keeps differently labelled edits as separate steps', () => {
    let h = initHistory({ a: '', b: '' })
    h = record(h, { a: 'x', b: '' }, 'title:s1')
    h = record(h, { a: 'x', b: 'y' }, 'title:s2')

    h = undo(h)
    expect(h.present).toEqual({ a: 'x', b: '' })
    h = undo(h)
    expect(h.present).toEqual({ a: '', b: '' })
  })

  it('treats an unlabelled change as its own step every time', () => {
    let h = initHistory(0)
    h = record(h, 1)
    h = record(h, 2)
    // Two nulls must not coalesce with each other — null means "discrete",
    // not "same as the last discrete thing".
    expect(undo(h).present).toBe(1)
  })

  it('abandons the redo branch once a new edit lands', () => {
    let h = initHistory(0)
    h = record(h, 1)
    h = undo(h)
    expect(canRedo(h)).toBe(true)

    h = record(h, 99)
    // Redoing to 1 from here would jump to a state that was never reachable
    // from 99, which is worse than losing it.
    expect(canRedo(h)).toBe(false)
    expect(h.present).toBe(99)
  })

  it('does not record a change that changes nothing', () => {
    const same = { n: 1 }
    let h = initHistory(same)
    h = record(h, same)
    expect(canUndo(h)).toBe(false)
  })

  it('bounds the history so a long session does not grow without limit', () => {
    let h = initHistory(0)
    for (let i = 1; i <= HISTORY_LIMIT + 20; i += 1) h = record(h, i)
    expect(h.past.length).toBe(HISTORY_LIMIT)
    // The most recent steps are the ones kept.
    expect(h.past[h.past.length - 1]).toBe(HISTORY_LIMIT + 19)
  })

  it('does nothing when there is nothing to undo or redo', () => {
    const h = initHistory(5)
    expect(undo(h)).toBe(h)
    expect(redo(h)).toBe(h)
  })
})

describe('moveItem', () => {
  it('moves an item forwards and backwards', () => {
    expect(moveItem(['a', 'b', 'c'], 0, 2)).toEqual(['b', 'c', 'a'])
    expect(moveItem(['a', 'b', 'c'], 2, 0)).toEqual(['c', 'a', 'b'])
  })

  it('matches what the up and down buttons do for adjacent moves', () => {
    // The arrows were the only way to reorder before M10. A drag that reordered
    // differently would be a second definition of what "move" means.
    expect(moveItem(['a', 'b', 'c'], 1, 0)).toEqual(['b', 'a', 'c'])
    expect(moveItem(['a', 'b', 'c'], 1, 2)).toEqual(['a', 'c', 'b'])
  })

  it('returns a copy rather than mutating', () => {
    const input = ['a', 'b', 'c']
    const out = moveItem(input, 0, 1)
    expect(input).toEqual(['a', 'b', 'c'])
    expect(out).not.toBe(input)
  })

  it('ignores an out-of-range move instead of corrupting the list', () => {
    // Reachable from a drag that ends outside the list, and from a keyboard
    // move at either end. Losing a section to a stray drop is not acceptable.
    expect(moveItem(['a', 'b'], 0, 5)).toEqual(['a', 'b'])
    expect(moveItem(['a', 'b'], -1, 1)).toEqual(['a', 'b'])
    expect(moveItem(['a', 'b'], 0, 0)).toEqual(['a', 'b'])
  })
})
