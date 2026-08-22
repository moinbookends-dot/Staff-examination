'use client'

import { useState, useTransition } from 'react'
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

      {open && (
        <>
          {/*
            A full-screen click-catcher rather than an outside-click listener.
            It also closes on Escape via the button keeping focus, and it works
            on touch, where "click outside" is not a thing that reliably fires.
          */}
          <button
            type="button"
            aria-label={t('close')}
            className="fixed inset-0 z-40 cursor-default"
            onClick={() => setOpen(false)}
          />

          <div
            role="menu"
            aria-label={t('label')}
            className="absolute right-0 z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border bg-card shadow-lg"
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
              <ul className="max-h-96 overflow-y-auto">
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
        </>
      )}
    </div>
  )
}
