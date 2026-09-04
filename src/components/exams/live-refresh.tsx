'use client'

import { useEffect } from 'react'
import { useRouter } from '@/lib/i18n/navigation'

/**
 * Keeps a monitoring page current while an exam is running.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ router.refresh() ON AN INTERVAL, NOT REALTIME — a sized decision. This    │
 * │ project has no Supabase Realtime channel anywhere, and standing one up    │
 * │ for a page a handful of chefs look at during an exam would be new         │
 * │ infrastructure for a polling problem. refresh() re-renders the server     │
 * │ components in place: React reconciles, scroll position and open filter   │
 * │ state in client components survive, and the page never "reloads".         │
 * │                                                                           │
 * │ Paused while the tab is hidden — a monitoring page left open overnight   │
 * │ must not poll the server all night — and resumed with an immediate        │
 * │ refresh on return, so the person never reads minutes-old numbers while    │
 * │ believing them fresh.                                                     │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Mounted only while the exam is live; the server page decides that.
 */
export function LiveRefresh({ seconds = 15 }: { seconds?: number }) {
  const router = useRouter()

  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === 'visible') router.refresh()
    }
    const id = setInterval(tick, seconds * 1000)
    document.addEventListener('visibilitychange', tick)
    return () => {
      clearInterval(id)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [router, seconds])

  return null
}
