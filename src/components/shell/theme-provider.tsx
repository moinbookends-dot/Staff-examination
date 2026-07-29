'use client'

import { ThemeProvider as NextThemesProvider } from 'next-themes'

/**
 * Makes the `.dark` block in globals.css reachable.
 *
 * It had always been written and never applied: the variant is class-based
 * (`@custom-variant dark (&:is(.dark *))`) and nothing ever put that class on
 * <html>, so the entire dark palette — and every `dark:` utility scattered
 * through the components — was dead code.
 *
 * `enableSystem` is off deliberately. With it on, `defaultTheme="dark"` only
 * applies to someone whose OS reports no preference, which in practice means
 * the product is system-first and merely claims to be dark-first. A visitor
 * who wants light picks it, and next-themes remembers.
 *
 * next-themes writes the class from a blocking inline script in <head>, before
 * paint, so there is no flash — but the server-rendered markup has no class
 * yet, which is why the <html> element carries suppressHydrationWarning.
 */
export function ThemeProvider({ children }: { children: React.ReactNode }) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem={false}
      disableTransitionOnChange
    >
      {children}
    </NextThemesProvider>
  )
}
