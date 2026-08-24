import Script from 'next/script'
import { THEME_SCRIPT } from '@/lib/theme'
import type { Metadata, Viewport } from 'next'
import { Hanken_Grotesk, JetBrains_Mono, Noto_Sans_Devanagari, Noto_Sans_Gujarati } from 'next/font/google'
import { NextIntlClientProvider, hasLocale } from 'next-intl'
import { notFound } from 'next/navigation'
import { routing } from '@/lib/i18n/routing'
import { Toaster } from '@/components/ui/sonner'
import { ServiceWorker } from '@/components/pwa/service-worker'
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

/**
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE METADATA THAT MAKES THIS INSTALLABLE.                                 │
 * │                                                                           │
 * │ `manifest` is what a browser reads to offer "Add to Home Screen"; the      │
 * │ appleWebApp block is the same conversation with iOS, which ignores the     │
 * │ manifest almost entirely and reads its own meta tags instead. Both are     │
 * │ needed — supporting only one leaves half the staff without an icon.        │
 * │                                                                           │
 * │ `statusBarStyle: 'default'` rather than the translucent option, because    │
 * │ translucent lets content slide under the clock and this app is used at     │
 * │ arm's length in a kitchen.                                                 │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export const metadata: Metadata = {
  title: 'Bookends Learning',
  description: 'Training and assessment for Aiko and Capiche',
  applicationName: 'Bookends Learning',
  manifest: '/manifest.webmanifest',
  appleWebApp: {
    capable: true,
    title: 'Bookends',
    statusBarStyle: 'default',
  },
  icons: {
    icon: [
      { url: '/icons/icon.svg', type: 'image/svg+xml' },
      { url: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
    ],
    apple: [{ url: '/icons/apple-touch-icon.png', sizes: '180x180' }],
  },
  // A phone installing this is not a search result; it is a tool somebody
  // was given. Nothing here should be indexed.
  formatDetection: { telephone: false },
}

/**
 * Viewport, and the two settings that matter on a phone.
 *
 * `viewportFit: 'cover'` lets the layout reach into the notch and home-
 * indicator areas, which is only safe because the shell pads itself with
 * env(safe-area-inset-*) — see globals.css.
 *
 * `userScalable` is left ALONE. Disabling zoom is the standard way to make
 * an app feel native and it takes pinch-to-zoom away from anybody who needs
 * it to read a question. The trade is not close.
 */
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0a0b' },
  ],
  viewportFit: 'cover',
  width: 'device-width',
  initialScale: 1,
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
    // suppressHydrationWarning: THEME_SCRIPT writes the theme class onto this
    // element before React hydrates, so the server markup and the live DOM
    // legitimately differ by one class name.
    <html
      lang={locale}
      suppressHydrationWarning
      className={`${sans.variable} ${mono.variable} ${devanagari.variable} ${gujarati.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {/*
          The pre-paint theme script — server-injected, never rendered by React.

          `beforeInteractive` is documented as "injected into the initial HTML
          from the server, downloaded before any Next.js module", which is what
          a no-flash theme needs: the class must be on <html> before the first
          paint, not after hydration.

          It lives HERE, in a Server Component, rather than inside a client
          provider, because a <script> rendered by a Client Component is never
          executed by React 19 and warns on every client navigation. That is
          the bug this replaced — see src/lib/theme.ts.

          There is no ThemeProvider: the theme has no React state to provide.
          useTheme() reads the class off <html> via useSyncExternalStore.
        */}
        <Script id="theme" strategy="beforeInteractive">
          {THEME_SCRIPT}
        </Script>

        <NextIntlClientProvider>
          {children}
          {/* Seven files called toast.success() into a void: sonner needs a
              mounted <Toaster /> and there was never one. */}
          <Toaster position="top-right" richColors closeButton />
          <ServiceWorker />
        </NextIntlClientProvider>
      </body>
    </html>
  )
}
