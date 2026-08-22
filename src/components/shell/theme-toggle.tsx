'use client'

import { useTheme } from '@/components/shell/use-theme'
import { useTranslations } from 'next-intl'
import { Moon, Sun } from 'lucide-react'
import { Button } from '@/components/ui/button'

/**
 * Light/dark switch.
 *
 * Which icon shows is decided by CSS (`dark:hidden` / `hidden dark:block`), not
 * by React state. The usual `const [mounted, setMounted] = useState(false)`
 * dance exists to avoid a hydration mismatch, but it costs a frame in which the
 * control is missing or blank, and the header visibly reflows. Letting the
 * class on <html> select the icon means the server can render both and be right
 * either way.
 *
 * `resolvedTheme` is undefined during the first render for the same reason —
 * that is fine here, because it is only read inside a click handler.
 */
export function ThemeToggle() {
  const t = useTranslations('common')
  const { resolvedTheme, setTheme } = useTheme()

  return (
    <Button
      variant="ghost"
      size="icon-sm"
      aria-label={t('theme')}
      title={t('theme')}
      onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
    >
      <Sun className="size-4 dark:hidden" />
      <Moon className="hidden size-4 dark:block" />
    </Button>
  )
}
