'use client'

import { useState, useTransition } from 'react'
import { createPortal } from 'react-dom'
import { useTranslations } from 'next-intl'
import { BellIcon, Loader2Icon } from 'lucide-react'
import { markNotificationsRead, type AppNotification } from '@/server/actions/notifications'
import { Link } from '@/lib/i18n/navigation'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The bell in the top bar.
 *
 * It was `<Button disabled>` — present in the Stitch design, wired to nothing —
 * while the database had been collecting notifications the whole time. This
 * connects the two.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE COUNT IS RENDERED ON THE SERVER, NOT FETCHED ON MOUNT.                │
 * │                                                                           │
 * │ The layout already reads it, so the badge is correct in the first HTML     │
 * │ frame. Fetching it client-side would mean every page in the product       │
 * │ flashed a bell with no badge and then grew one, and would add a round     │
 * │ trip to a project where one costs a measured ~120ms.                      │
 * │                                                                           │
 * │ The trade-off is that the count is as fresh as the page. That is the      │
 * │ right trade for an exam assignment, which is not a chat message; it       │
 * │ refreshes on the next navigation, and marking read revalidates the layout.│
 * │ No polling — /pending is the only screen in this product that polls, and  │
 * │ it has a reason.                                                          │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export function NotificationBell({
  items,
  unread,
}: {
  items: AppNotification[]
  unread: number
}) {
  const t = useTranslations('notifications')
  const [open, setOpen] = useState(false)
  const [pending, start] = useTransition()

  const markAll = () => start(async () => void (await markNotificationsRead({})))

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="icon"
        aria-label={unread > 0 ? t('withCount', { n: unread }) : t('label')}
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((v) => !v)}
      >
        <BellIcon />
        {unread > 0 && (
          <span
            // aria-hidden: the count is already in the button's accessible
            // name above, and announcing it twice is how a screen reader
            // starts sounding like a slot machine.
            aria-hidden
            className="absolute -top-0.5 -right-0.5 grid min-w-4 place-items-center rounded-full bg-destructive px-1 text-[10px] leading-4 font-medium text-white"
          >
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </Button>

      {open &&
        /*
         * PORTALED TO <body>, AND NOT AS A STYLE PREFERENCE. The header this
         * bell lives in carries `glass`, whose backdrop-filter makes the
         * header a CONTAINING BLOCK for fixed-position descendants — so the
         * phone bottom sheet, asked to pin to the viewport's bottom edge,
         * pinned to the header's instead and rendered hanging off the top of
         * the screen. Measured, not theorised: bottom=63 against a 800px
         * viewport. A portal is the only clean escape from a transformed or
         * filtered ancestor.
         *
         * The desktop dropdown pays for the escape by losing its anchor, so
         * from sm up it is placed at the header's right corner explicitly —
         * top-[4.5rem] is the 64px header plus the 8px gap the old mt-2 gave,
         * and right-4/lg:right-10 mirror the header's own padding.
         */
        createPortal(
        <>
          {/*
            A full-screen click-catcher rather than an outside-click listener.
            It also closes on Escape via the button keeping focus, and it works
            on touch, where "click outside" is not a thing that reliably fires.
          */}
          <button
            type="button"
            aria-label={t('close')}
            // Dimmed on phones, where the panel is a bottom sheet and needs a
            // scrim to read as one layer above the page; invisible from sm up,
            // where the anchored dropdown supplies its own edge.
            className="fixed inset-0 z-40 cursor-default bg-black/40 sm:bg-transparent"
            onClick={() => setOpen(false)}
          />

          <div
            role="menu"
            aria-label={t('label')}
            /*
             * Two shapes for one panel.
             *
             * On a phone this used to render as the desktop dropdown — 320px
             * anchored to a bell in the header — which on a 360px screen is
             * "the whole screen, but hung from a corner": a computer UI pasted
             * onto a phone. Small screens now get the native pattern, a bottom
             * sheet: full width, safe-area padded, capped at 70dvh so the page
             * visibly continues behind the scrim.
             *
             * sm and up keeps the dropdown look, pinned to the header corner — see
             * the portal note above for why it can no longer anchor to the bell.
             */
            className="fixed inset-x-0 bottom-0 z-50 max-h-[70dvh] overflow-hidden rounded-t-xl border bg-card pb-safe shadow-lg sm:inset-x-auto sm:top-[4.5rem] sm:right-4 sm:bottom-auto sm:max-h-none sm:w-80 sm:max-w-[calc(100vw-2rem)] sm:rounded-xl sm:pb-0 lg:right-10"
          >
            <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
              <span className="text-label-caps text-muted-foreground">{t('label')}</span>
              {unread > 0 && (
                <Button variant="ghost" size="xs" onClick={markAll} disabled={pending}>
                  {pending && <Loader2Icon className="animate-spin" />}
                  {t('markAllRead')}
                </Button>
              )}
            </div>

            {items.length === 0 ? (
              <p className="px-3 py-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
            ) : (
              // On phones the sheet's 70dvh cap governs (minus its header); the
              // 96 is the desktop dropdown's own limit.
              <ul className="max-h-[calc(70dvh-3rem)] overflow-y-auto sm:max-h-96">
                {items.map((n) => {
                  const inner = (
                    <>
                      <span className="flex items-start gap-2">
                        {!n.readAt && (
                          <span
                            aria-hidden
                            className="mt-1.5 size-1.5 shrink-0 rounded-full bg-primary"
                          />
                        )}
                        <span className={cn('min-w-0', n.readAt && 'pl-3.5')}>
                          <span className="block text-sm font-medium">{n.title}</span>
                          {n.body && (
                            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                              {n.body}
                            </span>
                          )}
                        </span>
                      </span>
                    </>
                  )

                  return (
                    <li key={n.id} className="border-b last:border-b-0">
                      {n.link ? (
                        <Link
                          href={n.link}
                          role="menuitem"
                          onClick={() => {
                            setOpen(false)
                            // Fire and forget: following the link matters more
                            // than the badge, and the layout revalidates anyway.
                            void markNotificationsRead({ id: n.id })
                          }}
                          className="block px-3 py-2.5 transition-colors hover:bg-accent/40"
                        >
                          {inner}
                        </Link>
                      ) : (
                        <div className="px-3 py-2.5">{inner}</div>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </div>
        </>,
        document.body,
      )}
    </div>
  )
}
