/**
 * Undo/redo over a draft, as a pure reducer.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHY A REDUCER AND NOT A STACK OF SETSTATE CALLS.                          │
 * │                                                                           │
 * │ The paper builder edits a nested structure — sections holding rules —     │
 * │ and every keystroke in a title is a state change. A naive history pushes  │
 * │ one entry per character, so Undo deletes one letter and a chef presses it │
 * │ forty times to get back to where they were.                               │
 * │                                                                           │
 * │ COALESCING is therefore part of the model rather than a refinement:       │
 * │ consecutive edits carrying the same `label` collapse into one entry. A    │
 * │ title being typed is one undo; adding a section is another.               │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Pure and generic on purpose — it is unit-testable without React, and the
 * builder is the thing least worth testing through a DOM.
 */

export interface History<T> {
  past: T[]
  present: T
  future: T[]
  /** What produced `present`. Used to coalesce, never shown to anyone. */
  label: string | null
}

/**
 * Deep enough for a paper: forty discrete actions is far more than anybody
 * retraces, and the whole draft is held per entry, so an unbounded history on a
 * large paper is real memory for no benefit.
 */
export const HISTORY_LIMIT = 40

export function initHistory<T>(present: T): History<T> {
  return { past: [], present, future: [], label: null }
}

/**
 * Record a new state.
 *
 * `label` decides coalescing: the same label twice in a row replaces the
 * present rather than pushing a new entry. Pass a distinct label — or none —
 * for anything that should be its own undo step.
 */
export function record<T>(history: History<T>, next: T, label: string | null = null): History<T> {
  if (Object.is(next, history.present)) return history

  const coalesce = label !== null && label === history.label
  return {
    past: coalesce ? history.past : [...history.past, history.present].slice(-HISTORY_LIMIT),
    present: next,
    // Any new edit abandons the redo branch. Keeping it would let Redo jump to
    // a state that was never reachable from here, which is worse than losing it.
    future: [],
    label,
  }
}

export function undo<T>(history: History<T>): History<T> {
  if (history.past.length === 0) return history
  const previous = history.past[history.past.length - 1]
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
    // Cleared so the next edit cannot coalesce into the entry just restored.
    label: null,
  }
}

export function redo<T>(history: History<T>): History<T> {
  if (history.future.length === 0) return history
  const [next, ...rest] = history.future
  return {
    past: [...history.past, history.present],
    present: next,
    future: rest,
    label: null,
  }
}

export const canUndo = <T,>(history: History<T>): boolean => history.past.length > 0
export const canRedo = <T,>(history: History<T>): boolean => history.future.length > 0

/**
 * Move an item within an array, returning a new array.
 *
 * Shared by the drag handler and the up/down buttons so the two cannot disagree
 * about what "move" means — the arrows were the only path before M10, and a
 * drag implementation that reordered differently would be a second definition
 * of ordering.
 */
export function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= items.length || to >= items.length) {
    return [...items]
  }
  const next = [...items]
  const [moved] = next.splice(from, 1)
  next.splice(to, 0, moved)
  return next
}
