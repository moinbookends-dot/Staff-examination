'use client'

import { createContext, useCallback, useContext, useMemo, useState, useSyncExternalStore } from 'react'
import { BULK_LIMIT } from '@/lib/questions/bulk'

/**
 * Which questions are selected, across pages and across filter changes.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHY THIS IS NOT COMPONENT STATE.                                          │
 * │                                                                           │
 * │ Filtering navigates: question-filters.tsx calls router.push, and every    │
 * │ sort, page-size and page change does the same. Under the App Router that  │
 * │ is a soft navigation, and a selection held in the table's own state would │
 * │ survive some of those and not others depending on where React decided to  │
 * │ remount — the worst possible behaviour, because it looks like it works    │
 * │ right up until it silently drops half of what you picked.                 │
 * │                                                                           │
 * │ So it lives in sessionStorage. Session, NOT local: a selection is a task  │
 * │ in progress, not a preference. Finding 200 questions still selected       │
 * │ tomorrow morning, with a Delete button next to the count, is not a        │
 * │ feature.                                                                  │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHY useSyncExternalStore AND NOT useState + useEffect.                    │
 * │                                                                           │
 * │ Reading sessionStorage during render would produce different markup on    │
 * │ the server than in the browser, and hydration would silently discard one  │
 * │ of them. The usual dodge — empty state, then setState in an effect — is   │
 * │ what React's own lint rule now rejects, and for a good reason here: it    │
 * │ renders one frame with an empty selection, so a toolbar that appears on   │
 * │ a non-empty selection flickers on every navigation.                       │
 * │                                                                           │
 * │ useSyncExternalStore is built for exactly this: getServerSnapshot returns │
 * │ the empty set, getSnapshot reads storage, and the cache below keeps the   │
 * │ returned reference stable — without it React re-renders forever, because  │
 * │ a fresh Set is never equal to the last one.                               │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * The ids here are only ever *proposals*. Every action they feed re-checks
 * permission and runs under RLS, so a selection containing something the caller
 * may not touch comes back reported as skipped, not applied. Nothing in this
 * file is a security boundary and it must never be treated as one.
 */

const STORAGE_KEY = 'bookends.questions.selection.v1'

const EMPTY: ReadonlySet<string> = new Set()

/** Last raw string parsed, and what it parsed to. Keeps the snapshot stable. */
let cachedRaw: string | null = null
let cachedSet: ReadonlySet<string> = EMPTY

/**
 * A shadow of the stored value, used when sessionStorage is unavailable —
 * private browsing, or a full quota. Selection still works for the session;
 * it just will not survive a navigation, which is the graceful direction.
 */
let fallbackRaw: string | null = null

const listeners = new Set<() => void>()

function readRaw(): string | null {
  try {
    return sessionStorage.getItem(STORAGE_KEY)
  } catch {
    return fallbackRaw
  }
}

function getSnapshot(): ReadonlySet<string> {
  const raw = readRaw()
  if (raw === cachedRaw) return cachedSet
  cachedRaw = raw
  if (!raw) {
    cachedSet = EMPTY
    return cachedSet
  }
  try {
    const ids: unknown = JSON.parse(raw)
    cachedSet = Array.isArray(ids)
      ? new Set(ids.filter((id): id is string => typeof id === 'string'))
      : EMPTY
  } catch {
    // A corrupted store means an empty selection, which is the safe direction:
    // it under-selects rather than over-selects.
    cachedSet = EMPTY
  }
  return cachedSet
}

const getServerSnapshot = (): ReadonlySet<string> => EMPTY

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function write(next: ReadonlySet<string>): void {
  const raw = JSON.stringify([...next])
  fallbackRaw = raw
  try {
    sessionStorage.setItem(STORAGE_KEY, raw)
  } catch {
    // Kept in fallbackRaw above.
  }
  for (const listener of listeners) listener()
}

interface SelectionState {
  selected: ReadonlySet<string>
  count: number
  isSelected: (id: string) => boolean
  toggle: (id: string) => void
  selectMany: (ids: readonly string[]) => void
  deselectMany: (ids: readonly string[]) => void
  clear: () => void
  /**
   * True once the user has escalated from "this page" to "everything matching
   * the filter". Purely so the toolbar can say which one it is holding — the
   * ids are the same shape either way. Not persisted: an escalation is a claim
   * about a filter, and the filter may be different after a navigation.
   */
  isFilterWide: boolean
  setFilterWide: (value: boolean) => void
  /** How many rows matched, when that is more than we are allowed to hold. */
  matchedTotal: number | null
  setMatchedTotal: (total: number | null) => void
  limit: number
}

const SelectionContext = createContext<SelectionState | null>(null)

export function useQuestionSelection(): SelectionState {
  const ctx = useContext(SelectionContext)
  if (!ctx) {
    throw new Error('useQuestionSelection must be used inside <QuestionSelectionProvider>')
  }
  return ctx
}

export function QuestionSelectionProvider({ children }: { children: React.ReactNode }) {
  const selected = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)
  const [isFilterWide, setFilterWide] = useState(false)
  const [matchedTotal, setMatchedTotal] = useState<number | null>(null)

  const toggle = useCallback((id: string) => {
    const next = new Set(getSnapshot())
    if (!next.delete(id)) next.add(id)
    write(next)
  }, [])

  const selectMany = useCallback((ids: readonly string[]) => {
    const next = new Set(getSnapshot())
    for (const id of ids) next.add(id)
    write(next)
  }, [])

  const deselectMany = useCallback((ids: readonly string[]) => {
    const next = new Set(getSnapshot())
    for (const id of ids) next.delete(id)
    write(next)
  }, [])

  const clear = useCallback(() => {
    write(EMPTY)
    setFilterWide(false)
    setMatchedTotal(null)
  }, [])

  const value = useMemo<SelectionState>(
    () => ({
      selected,
      count: selected.size,
      isSelected: (id) => selected.has(id),
      toggle,
      selectMany,
      deselectMany,
      clear,
      isFilterWide,
      setFilterWide,
      matchedTotal,
      setMatchedTotal,
      limit: BULK_LIMIT,
    }),
    [selected, toggle, selectMany, deselectMany, clear, isFilterWide, matchedTotal],
  )

  return <SelectionContext.Provider value={value}>{children}</SelectionContext.Provider>
}
