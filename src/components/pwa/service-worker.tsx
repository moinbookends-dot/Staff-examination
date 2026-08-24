'use client'

import { useEffect } from 'react'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Registers the service worker that makes this installable.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ A COMPONENT THAT RENDERS NOTHING, AND HAS TO BE ONE.                      ║
 * ║                                                                           ║
 * ║ Registration needs `navigator`, so it cannot happen on the server. Doing  ║
 * ║ it in an effect rather than during render also means it runs AFTER the    ║
 * ║ page is interactive — the worker is a background improvement and must     ║
 * ║ never be on the critical path of somebody opening an exam.                ║
 * ║                                                                           ║
 * ║ DEVELOPMENT IS EXCLUDED DELIBERATELY. A worker cached against a dev       ║
 * ║ server outlives the dev server, and the symptom — an app serving assets   ║
 * ║ from a build that no longer exists — costs an afternoon to recognise.     ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */
export function ServiceWorker() {
  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') return
    if (!('serviceWorker' in navigator)) return

    /*
     * After load, not during it. Registration competes for the same connection
     * as the page's own assets, and on the phone-on-kitchen-wifi this app is
     * built for, that competition is not free.
     */
    const register = () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {
        /*
         * Swallowed on purpose. A worker that fails to register leaves a
         * perfectly working web app — every screen still loads from the
         * network. There is nothing here worth interrupting somebody for.
         */
      })
    }

    if (document.readyState === 'complete') register()
    else {
      window.addEventListener('load', register)
      return () => window.removeEventListener('load', register)
    }
  }, [])

  return null
}
