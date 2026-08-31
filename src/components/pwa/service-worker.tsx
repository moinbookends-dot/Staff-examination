'use client'

import { useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Registers the service worker that makes this installable — and, since the
 * Paper-15 incident, tells people when a new version is waiting.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ WHY THE UPDATE TOAST EXISTS. An installed app on a phone is often never   ║
 * ║ fully closed: the page stays alive across days, navigation is all         ║
 * ║ client-side, and the bundle that loaded last week keeps running. A bug    ║
 * ║ fixed and deployed on Wednesday was reported as still broken on Friday    ║
 * ║ by somebody whose app had simply never reloaded. The worker deliberately  ║
 * ║ refuses to take over mid-session (see sw.js), so without a prompt there   ║
 * ║ is NO moment at which a long-lived install picks up a fix.                ║
 * ║                                                                           ║
 * ║ THE PROMPT NEVER SHOWS DURING AN EXAM. A reload offer over a timed paper  ║
 * ║ is a trap — declined-or-not it competes for attention, and accepted it    ║
 * ║ costs the candidate their flow. On /attempt/ routes the offer is held     ║
 * ║ and re-evaluated when the page next becomes visible somewhere safe.       ║
 * ║                                                                           ║
 * ║ The reload happens ONLY from the person's tap: the button messages the    ║
 * ║ waiting worker to take over, and the controllerchange that follows        ║
 * ║ triggers one reload — gated on that tap, so a takeover initiated by       ║
 * ║ another tab can never yank this one.                                      ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * DEVELOPMENT IS EXCLUDED DELIBERATELY. A worker cached against a dev server
 * outlives the dev server, and the symptom — an app serving assets from a
 * build that no longer exists — costs an afternoon to recognise.
 * ═══════════════════════════════════════════════════════════════════════════
 */

/** How often a long-lived page asks the browser to re-check /sw.js. */
const UPDATE_CHECK_MS = 30 * 60 * 1000

export function ServiceWorker() {
  const t = useTranslations('pwa')

  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return
    if (!('serviceWorker' in navigator)) return

    let registration: ServiceWorkerRegistration | null = null
    let accepted = false
    let prompted = false
    let interval: ReturnType<typeof setInterval> | null = null

    const inExam = () => /\/attempt\//.test(window.location.pathname)

    const offerReload = () => {
      const waiting = registration?.waiting
      if (!waiting || prompted || inExam()) return
      prompted = true

      toast(t('updateReady'), {
        // Sticky: a deploy notice that dismisses itself was never seen.
        duration: Infinity,
        action: {
          label: t('reload'),
          onClick: () => {
            accepted = true
            waiting.postMessage({ type: 'SKIP_WAITING' })
          },
        },
        onDismiss: () => {
          // Declined for now. Allow a later deploy to ask again.
          prompted = false
        },
      })
    }

    const watchInstalling = (reg: ServiceWorkerRegistration) => {
      const installing = reg.installing
      if (!installing) return
      installing.addEventListener('statechange', () => {
        // installed + an existing controller = an UPDATE is waiting. On the
        // very first install there is no controller and nothing to announce.
        if (installing.state === 'installed' && navigator.serviceWorker.controller) offerReload()
      })
    }

    const onControllerChange = () => {
      // Only the reload the person asked for. Without the gate, a second tab
      // accepting the update would reload this one mid-whatever.
      if (accepted) window.location.reload()
    }
    navigator.serviceWorker.addEventListener('controllerchange', onControllerChange)

    const onVisible = () => {
      if (document.visibilityState !== 'visible') return
      // A resumed app is exactly the long-lived page this exists for.
      registration?.update().catch(() => {})
      offerReload()
    }
    document.addEventListener('visibilitychange', onVisible)

    /*
     * After load, not during it. Registration competes for the same connection
     * as the page's own assets, and on the phone-on-kitchen-wifi this app is
     * built for, that competition is not free.
     */
    const register = () => {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
        .then((reg) => {
          registration = reg
          // An update may already be sitting there from a previous session.
          if (reg.waiting) offerReload()
          reg.addEventListener('updatefound', () => watchInstalling(reg))
          interval = setInterval(() => reg.update().catch(() => {}), UPDATE_CHECK_MS)
        })
        .catch(() => {
          /*
           * Swallowed on purpose. A worker that fails to register leaves a
           * perfectly working web app — every screen still loads from the
           * network. There is nothing here worth interrupting somebody for.
           */
        })
    }

    if (document.readyState === 'complete') register()
    else window.addEventListener('load', register, { once: true })

    return () => {
      window.removeEventListener('load', register)
      document.removeEventListener('visibilitychange', onVisible)
      navigator.serviceWorker.removeEventListener('controllerchange', onControllerChange)
      if (interval) clearInterval(interval)
    }
  }, [t])

  return null
}
