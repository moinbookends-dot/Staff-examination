'use client'

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The platform side of Exam Mode: keep the screen on, fill it, and make
 * leaving deliberate.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ EVERY ONE OF THESE IS BEST-EFFORT, AND THAT IS STATED RATHER THAN HIDDEN. ║
 * ║                                                                           ║
 * ║ Wake Lock is unsupported on older iOS and is revoked by the system        ║
 * ║ whenever the tab is hidden. Fullscreen is refused outside a user gesture  ║
 * ║ and is unavailable on iOS Safari altogether. `beforeunload` shows the     ║
 * ║ browser's own wording, not ours, and some browsers ignore it entirely.    ║
 * ║                                                                           ║
 * ║ So none of this is a security boundary and none of it is treated as one.  ║
 * ║ What actually protects the exam is server-side: expires_at is enforced by ║
 * ║ save_answer on every write, a cron sweeper closes overdue attempts, and   ║
 * ║ RLS decides what a candidate may read. This hook only removes distraction ║
 * ║ and prevents ACCIDENTS — a sleeping screen, a mis-swipe, a stray back.    ║
 * ║                                                                           ║
 * ║ WHAT MUST NOT BE ADDED HERE: anything claiming to prevent screenshots or  ║
 * ║ to detect other applications. The web platform cannot do either, and      ║
 * ║ pretending otherwise would tell an examiner they have a guarantee they    ║
 * ║ do not have.                                                              ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** Not in lib.dom for every TS target yet, so the shape is named locally. */
interface WakeLockSentinelLike {
  released: boolean
  release: () => Promise<void>
  addEventListener: (type: 'release', listener: () => void) => void
}

/**
 * Hold the screen awake for as long as the exam is live.
 *
 * Re-acquired on visibility change because the system drops the lock whenever
 * the tab is hidden — without that, one glance at a notification leaves the
 * screen free to sleep for the rest of the paper.
 */
export function useWakeLock(active: boolean): void {
  const sentinel = useRef<WakeLockSentinelLike | null>(null)

  useEffect(() => {
    if (!active) return

    const wakeLock = (
      navigator as Navigator & {
        wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> }
      }
    ).wakeLock

    if (!wakeLock) return

    let cancelled = false

    const acquire = async () => {
      if (cancelled || document.visibilityState !== 'visible') return
      if (sentinel.current && !sentinel.current.released) return

      try {
        const lock = await wakeLock.request('screen')
        if (cancelled) {
          void lock.release()
          return
        }
        sentinel.current = lock
      } catch {
        /*
         * Refused — low battery, an unsupported browser, a policy. The exam is
         * unaffected; the screen may simply dim as it normally would. Nothing
         * here is worth interrupting a candidate for.
         */
      }
    }

    const onVisible = () => {
      if (document.visibilityState === 'visible') void acquire()
    }

    void acquire()
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisible)
      // Released the moment the exam ends. A lock outliving its reason is a
      // battery complaint nobody will connect back to this screen.
      void sentinel.current?.release().catch(() => {})
      sentinel.current = null
    }
  }, [active])
}

/**
 * Ask for the whole screen. Must be called from a user gesture.
 *
 * Returns nothing and throws nothing: an installed PWA is already chrome-less,
 * iOS Safari has no Fullscreen API at all, and in both cases the exam is
 * perfectly usable without it.
 */
export async function requestFullscreen(): Promise<void> {
  try {
    const el = document.documentElement as HTMLElement & {
      webkitRequestFullscreen?: () => Promise<void>
    }
    if (document.fullscreenElement) return

    if (el.requestFullscreen) await el.requestFullscreen({ navigationUI: 'hide' })
    else if (el.webkitRequestFullscreen) await el.webkitRequestFullscreen()
  } catch {
    /* Refused or unsupported. See the box above. */
  }
}

/** Give the screen back, if we ever had it. */
export async function exitFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) await document.exitFullscreen()
  } catch {
    /* Already gone, or never granted. */
  }
}

/**
 * Make leaving a live attempt deliberate.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ TWO ROUTES OUT, AND THEY NEED DIFFERENT ANSWERS.                          │
 * │                                                                           │
 * │ Closing the tab or reloading is the browser's business: `beforeunload` is │
 * │ the only hook, it shows the browser's own wording, and it cannot be       │
 * │ styled or replaced. Fine — the answers are in the outbox either way.      │
 * │                                                                           │
 * │ Going BACK is ours. A history entry is pushed on mount so the first back  │
 * │ press lands on it instead of leaving; we then ask, and only leave if the  │
 * │ candidate says so. Without the guard, one careless swipe on a phone       │
 * │ abandons a timed exam with no prompt at all.                              │
 * │                                                                           │
 * │ Neither ever submits. Leaving is not finishing, the timer keeps running   │
 * │ server-side, and deciding otherwise for somebody would be worse than any  │
 * │ accident this prevents.                                                   │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * @param active While false — already submitted, or timed out — nothing is
 *   guarded: at that point there is nothing left to lose by leaving.
 * @param onAttemptedExit Called when back is pressed. Show the confirmation.
 */
export function useExitGuard(active: boolean, onAttemptedExit: () => void): void {
  useEffect(() => {
    if (!active) return

    const warn = (event: BeforeUnloadEvent) => {
      // preventDefault is the modern spelling; returnValue is what older
      // browsers still read. Both, because either alone misses somebody.
      event.preventDefault()
      event.returnValue = ''
    }

    /*
     * The sentinel entry. Popping it is how we learn back was pressed, and
     * pushing it again is how we stay put while the question is asked.
     */
    window.history.pushState({ examGuard: true }, '')

    const onPop = () => {
      window.history.pushState({ examGuard: true }, '')
      onAttemptedExit()
    }

    window.addEventListener('beforeunload', warn)
    window.addEventListener('popstate', onPop)

    return () => {
      window.removeEventListener('beforeunload', warn)
      window.removeEventListener('popstate', onPop)
    }
  }, [active, onAttemptedExit])
}

/**
 * Whether the browser currently believes it has a connection.
 *
 * `navigator.onLine` is famously optimistic — it reports a working Wi-Fi
 * association, not a reachable server — so this drives the BANNER only. What
 * decides whether an answer is safe is the outbox, which tracks server
 * acknowledgements rather than the browser's opinion.
 */
export function useOnline(): boolean {
  /*
   * useSyncExternalStore rather than state-plus-effect, because that is
   * precisely what this is: a value owned outside React that changes on its
   * own. Reading it in an effect would mean rendering once with a guess and
   * again with the truth, which React now rejects outright — and it also gives
   * the server snapshot for free.
   *
   * The server snapshot is `true`: a page rendered on a machine with no
   * `navigator` cannot know, and opening an exam behind a banner that says the
   * connection is gone would be a worse first impression than a banner that
   * appears a moment later on a device that really is offline.
   */
  return useSyncExternalStore(subscribeToConnection, () => navigator.onLine, () => true)
}

function subscribeToConnection(onChange: () => void): () => void {
  window.addEventListener('online', onChange)
  window.addEventListener('offline', onChange)
  return () => {
    window.removeEventListener('online', onChange)
    window.removeEventListener('offline', onChange)
  }
}

/** Convenience for the runner: one call to enter, one to leave. */
export function useExamChrome(active: boolean) {
  useWakeLock(active)

  const enter = useCallback(async () => {
    await requestFullscreen()
  }, [])

  useEffect(() => {
    if (active) return
    // The exam is over — hand the screen back rather than leaving the results
    // card sitting in a fullscreen the candidate did not ask to stay in.
    void exitFullscreen()
  }, [active])

  return { enter }
}
