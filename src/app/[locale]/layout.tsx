import type { Metadata } from 'next'
import { Hanken_Grotesk, JetBrains_Mono, Noto_Sans_Devanagari, Noto_Sans_Gujarati } from 'next/font/google'
import { NextIntlClientProvider, hasLocale } from 'next-intl'
import { notFound } from 'next/navigation'
import { routing } from '@/lib/i18n/routing'
import { ThemeProvider } from '@/components/shell/theme-provider'
import { Toaster } from '@/components/ui/sonner'
import '../globals.css'

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Typefaces, per the Proctor design system (DESIGN.md).
 *
 * Hanken Grotesk for everything, JetBrains Mono for the `label-caps` role —
 * metadata, ID tags and status labels, where a technical contrast against the
 * editorial body text is wanted.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE TWO NOTO FACES CLOSE A GAP THIS FILE HAS CARRIED SINCE M1.            │
 * │                                                                           │
 * │ The previous comment here read: "Geist ships a Latin subset only. Hindi   │
 * │ and Gujarati use Devanagari and Gujarati scripts, so those glyphs         │
 * │ currently fall back to a system font."                                    │
 * │                                                                           │
 * │ Hanken Grotesk has exactly the same limitation, so swapping one Latin     │
 * │ face for another would have carried the gap forward. On Windows the       │
 * │ fallback is passable; on a Linux server-rendered screenshot or a machine  │
 * │ without a Devanagari face it is tofu.                                     │
 * │                                                                           │
 * │ The variables are appended to the font stack in globals.css rather than   │
 * │ swapped per locale: a Hindi question can appear on an English-language    │
 * │ screen — the Question Bank shows all three — so the SCRIPT, not the       │
 * │ page's locale, has to pick the face. The browser does that per glyph if   │
 * │ the stack lists them.                                                     │
 * │                                                                           │
 * │ Note this is the OPPOSITE arrangement from the PDF renderer, which must   │
 * │ pick one family per document because react-pdf has no fallback at all.    │
 * └───────────────────────────────────────────────────────────────────────────┘
 * ═══════════════════════════════════════════════════════════════════════════
 */
const sans = Hanken_Grotesk({
  variable: '--font-sans-latin',
  subsets: ['latin'],
  display: 'swap',
})

const mono = JetBrains_Mono({
  variable: '--font-mono-latin',
  subsets: ['latin'],
  display: 'swap',
})

const devanagari = Noto_Sans_Devanagari({
  variable: '--font-devanagari',
  subsets: ['devanagari'],
  display: 'swap',
})

const gujarati = Noto_Sans_Gujarati({
  variable: '--font-gujarati',
  subsets: ['gujarati'],
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'Bookends Learning',
  description: 'Training and assessment for Aiko, Capiche and Prep',
}

/** Pre-render all three locales at build time. */
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
      className={`${sans.variable} ${mono.variable} ${devanagari.variable} ${gujarati.variable} h-full antialiased`}
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
