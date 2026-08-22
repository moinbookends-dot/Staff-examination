'use client'

import { useCallback, useSyncExternalStore } from 'react'
import { DEFAULT_THEME, THEME_STORAGE_KEY, type Theme } from '@/lib/theme'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The theme, read from where it actually lives: the class on <html>.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THERE IS NO PROVIDER, AND NO useState/useEffect PAIR.                     ║
 * ║                                                                           ║
 * ║ The theme is not React state. It is written to <html> before React exists ║
 * ║ — by THEME_SCRIPT, injected server-side in the root layout — and it can   ║
 * ║ change from another tab. That is the definition of an external store, so  ║
 * ║ this uses useSyncExternalStore rather than mirroring the DOM into state   ║
 * ║ and trying to keep the copy honest.                                       ║
 * ║                                                                           ║
 * ║ The first attempt DID mirror it, with `setTheme(readDom())` in an effect. ║
 * ║ react-hooks/set-state-in-effect rejected it, correctly: that pattern      ║
 * ║ renders once with a value known to be wrong, then re-renders, and is a    ║
 * ║ tearing bug waiting for a second subscriber.                              ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * Why the DOM and not localStorage is the source of truth: storage can throw
 * (blocked cookies, private mode) and can hold a stale value if the pre-paint
 * script fell back. What is on <html> is what the user is actually looking at.
 * ═══════════════════════════════════════════════════════════════════════════
 */

const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

/** Another tab changed the theme. Mirror it here so two tabs cannot drift. */
function onStorage(event: StorageEvent) {
  if (event.key !== THEME_STORAGE_KEY) return
  applyToDocument(event.newValue === 'light' ? 'light' : 'dark')
  emit()
}

function subscribe(listener: () => void) {
  if (listeners.size === 0) window.addEventListener('storage', onStorage)
  listeners.add(listener)

  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) window.removeEventListener('storage', onStorage)
  }
}

/**
 * Returns a primitive, so useSyncExternalStore's identity check is a value
 * comparison and no memoised snapshot is needed.
 */
function getSnapshot(): Theme {
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

/**
 * The server has no <html> to read, and must render what THEME_SCRIPT will
 * decide by default — anything else is a hydration mismatch on every request
 * from a visitor who has never chosen.
 */
function getServerSnapshot(): Theme {
  return DEFAULT_THEME
}

function applyToDocument(theme: Theme) {
  const el = document.documentElement
  el.classList.toggle('dark', theme === 'dark')
  // Matches built-in controls and scrollbars to the theme. Cheap, and its
  // absence is visible on form fields and select popups.
  el.style.colorScheme = theme
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot)

  const setTheme = useCallback((next: Theme) => {
    applyToDocument(next)
    try {
      localStorage.setItem(THEME_STORAGE_KEY, next)
    } catch {
      // Blocked storage must not stop the theme changing for this page.
    }
    emit()
  }, [])

  // `resolvedTheme` is identical to `theme`: there is no system option to
  // resolve. Kept because callers read that name.
  return { theme, resolvedTheme: theme, setTheme }
}
