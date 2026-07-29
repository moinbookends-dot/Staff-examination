import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import { NextIntlClientProvider, hasLocale } from 'next-intl'
import { notFound } from 'next/navigation'
import { routing } from '@/lib/i18n/routing'
import { ThemeProvider } from '@/components/shell/theme-provider'
import { Toaster } from '@/components/ui/sonner'
import '../globals.css'

const geistSans = Geist({ variable: '--font-geist-sans', subsets: ['latin'] })
const geistMono = Geist_Mono({ variable: '--font-geist-mono', subsets: ['latin'] })

export const metadata: Metadata = {
  title: 'Bookends Learning',
  description: 'Training and assessment for Aiko, Capiche and Prep',
}

/**
 * Pre-render all four locales at build time.
 *
 * KNOWN GAP: Geist ships a Latin subset only. Hindi and Gujarati use Devanagari
 * and Gujarati scripts, so those glyphs currently fall back to a system font.
 * Add script-appropriate webfonts at M8 when real translations land — recorded
 * here so it is a known gap rather than a surprise bug report from an outlet.
 */
export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }))
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params

  // /fr/dashboard must 404, not silently render English at a URL that claims
  // to be French.
  if (!hasLocale(routing.locales, locale)) {
    notFound()
  }

  return (
    // suppressHydrationWarning: next-themes writes the theme class onto this
    // element from an inline script before React hydrates, so the server markup
    // and the live DOM legitimately differ by one class name.
    <html
      lang={locale}
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <ThemeProvider>
          <NextIntlClientProvider>
            {children}
            {/* Seven files called toast.success() into a void: sonner needs a
                mounted <Toaster /> and there was never one. */}
            <Toaster position="top-right" richColors closeButton />
          </NextIntlClientProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
