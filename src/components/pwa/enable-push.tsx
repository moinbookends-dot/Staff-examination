'use client'

import { useEffect, useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { BellRingIcon, CheckIcon } from 'lucide-react'
import { savePushSubscription, removePushSubscription } from '@/server/actions/push'
import { Button } from '@/components/ui/button'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * "Notify me on this device."
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ STATE IS READ FROM THE BROWSER, NOT FROM THE DATABASE. What matters to    ║
 * ║ this button is whether THIS browser holds a live push subscription —     ║
 * ║ a DB row proves nothing about the device in hand, and the browser's own  ║
 * ║ pushManager.getSubscription() is the sole authority. The server is only  ║
 * ║ told the outcome.                                                        ║
 * ║                                                                          ║
 * ║ requestPermission() MUST run inside the click handler. Browsers ignore   ║
 * ║ permission prompts that a page fires on its own — and they are right to; ║
 * ║ asking on load is how sites teach people to reflex-deny forever.         ║
 * ║                                                                          ║
 * ║ iOS: Web Push exists from 16.4, and ONLY once the app is installed to    ║
 * ║ the home screen. In a plain Safari tab `PushManager` is undefined, so    ║
 * ║ this renders nothing rather than a button that cannot work.              ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 * ═══════════════════════════════════════════════════════════════════════════
 */

/**
 * applicationServerKey wants raw bytes; the VAPID key ships base64url.
 * Built over an explicit ArrayBuffer: TS 5.7 types Uint8Array.from's result
 * as Uint8Array<ArrayBufferLike>, which the DOM's BufferSource refuses.
 */
function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url + '='.repeat((4 - (base64url.length % 4)) % 4)
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

type State = 'unsupported' | 'blocked' | 'off' | 'on' | 'working'

export function EnablePush({ variant = 'settings' }: { variant?: 'settings' | 'banner' } = {}) {
  const t = useTranslations('push')
  const [state, setState] = useState<State>('unsupported')
  const [, start] = useTransition()

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return
      if (Notification.permission === 'denied') {
        if (!cancelled) setState('blocked')
        return
      }
      const reg = await navigator.serviceWorker.ready
      const sub = await reg.pushManager.getSubscription()
      if (!cancelled) setState(sub ? 'on' : 'off')
    })().catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  const enable = () =>
    start(async () => {
      setState('working')
      try {
        // Inside the gesture, before anything async enough to detach from it.
        const permission = await Notification.requestPermission()
        if (permission !== 'granted') {
          setState(permission === 'denied' ? 'blocked' : 'off')
          return
        }
        const reg = await navigator.serviceWorker.ready
        const sub = await reg.pushManager.subscribe({
          // Required by Chrome: every push must surface a visible notification,
          // which is also exactly what the service worker does.
          userVisibleOnly: true,
          applicationServerKey: keyBytes(process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? ''),
        })
        const result = await savePushSubscription(sub.toJSON())
        if (!result.ok) {
          // The server refused the registration — a subscription it will
          // never send to is dead weight in this browser; release it.
          await sub.unsubscribe()
          setState('off')
          return
        }
        setState('on')
      } catch {
        setState('off')
      }
    })

  const disable = () =>
    start(async () => {
      setState('working')
      try {
        const reg = await navigator.serviceWorker.ready
        const sub = await reg.pushManager.getSubscription()
        if (sub) {
          await removePushSubscription({ endpoint: sub.endpoint })
          await sub.unsubscribe()
        }
      } finally {
        setState('off')
      }
    })

  // No support (plain iOS Safari tab, ancient browser): nothing to offer.
  if (state === 'unsupported') return null

  /*
   * The banner variant lives on my-exams and exists only to ASK. Once push is
   * on — or the person has said no in browser settings — repeating either
   * fact at the top of their exam list every day is nagging, and Settings
   * remains the place to manage it.
   */
  if (variant === 'banner' && (state === 'on' || state === 'blocked')) return null

  if (variant === 'banner') {
    return (
      <div className="surface-1 flex flex-wrap items-center justify-between gap-3 rounded-xl p-4">
        <p className="min-w-0 flex-1 text-sm text-muted-foreground">{t('why')}</p>
        <Button onClick={enable} disabled={state === 'working'} size="sm" className="min-h-11">
          <BellRingIcon aria-hidden className="size-4" />
          {t('enable')}
        </Button>
      </div>
    )
  }

  if (state === 'blocked') {
    return <p className="text-sm text-muted-foreground">{t('blocked')}</p>
  }

  if (state === 'on') {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex items-center gap-2 text-sm">
          <CheckIcon aria-hidden className="size-4 text-primary" />
          {t('enabled')}
        </p>
        <Button variant="outline" size="sm" onClick={disable} className="min-h-11">
          {t('disable')}
        </Button>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">{t('why')}</p>
      <Button onClick={enable} disabled={state === 'working'} className="min-h-11">
        <BellRingIcon aria-hidden className="size-4" />
        {t('enable')}
      </Button>
    </div>
  )
}
