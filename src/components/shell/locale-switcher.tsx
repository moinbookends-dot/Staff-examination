'use client'

import { useTransition } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Languages } from 'lucide-react'
import { usePathname, useRouter } from '@/lib/i18n/navigation'
import { routing, LOCALE_LABELS, type Locale } from '@/lib/i18n/routing'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'

/**
 * Language switcher.
 *
 * Uses usePathname/useRouter from @/lib/i18n/navigation — the locale-aware
 * versions. The raw next/navigation ones would drop the prefix and bounce the
 * user to the default locale.
 *
 * Switching keeps the user on the same page rather than sending them home:
 * someone who reaches for this mid-task is usually confused by the current
 * screen, and losing their place makes that worse.
 */
export function LocaleSwitcher() {
  const t = useTranslations('common')
  const locale = useLocale() as Locale
  const pathname = usePathname()
  const router = useRouter()
  const [pending, startTransition] = useTransition()

  function switchTo(next: Locale) {
    startTransition(() => {
      router.replace(pathname, { locale: next })
    })
  }

  return (
    <DropdownMenu>
      {/* shadcn's dropdown is built on Base UI, not Radix — composition uses
          `render={<El />}` rather than Radix's `asChild`. */}
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="sm" disabled={pending} aria-label={t('language')} />}
      >
        <Languages className="size-4" />
        <span className="hidden sm:inline">{LOCALE_LABELS[locale]}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {routing.locales.map((l) => (
          <DropdownMenuItem
            key={l}
            onClick={() => switchTo(l)}
            className={l === locale ? 'font-medium' : undefined}
          >
            {LOCALE_LABELS[l]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
