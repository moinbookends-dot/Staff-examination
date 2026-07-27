import { defineRouting } from 'next-intl/routing'

/**
 * Locale routing.
 *
 * PATH-BASED (`/en/exams`), not cookie-based. Three reasons, in the order they
 * matter for this product:
 *
 *  1. Shareable links. A chef sends an exam link over WhatsApp to a
 *     Gujarati-speaking cook and it opens in Gujarati. With a cookie, it opens
 *     in whatever the chef's browser last set.
 *  2. Reading a cookie inside a Server Component forces the whole route
 *     dynamic. Path-prefixed locales stay statically analysable and cacheable
 *     per locale.
 *  3. Debuggable. A non-technical user reporting a translation bug can just
 *     send the URL.
 *
 * ON 'hi-Latn': this is Hinglish — Hindi written in Latin script. It is the
 * correct BCP-47 form (script subtag), not an invented code like "hinglish".
 * Using the standard tag means Intl falls back to Hindi rules for numbers and
 * dates, which is what you want.
 *
 * NOTE: PRD §2.2 says trilingual (EN/HI/GU) while §4.10 says four modes
 * including Hinglish. Four are declared here; §9's cut list drops gu and
 * hi-Latn first if velocity slips.
 */
export const routing = defineRouting({
  locales: ['en', 'hi', 'gu', 'hi-Latn'],
  defaultLocale: 'en',

  // Always prefix, including the default. Mixed prefixing (`/exams` for English
  // but `/hi/exams` for Hindi) produces two URLs for the same page and a
  // steady trickle of routing bugs.
  localePrefix: 'always',

  localeCookie: {
    name: 'NEXT_LOCALE',
    maxAge: 60 * 60 * 24 * 365,
  },
})

export type Locale = (typeof routing.locales)[number]

/** Human-readable names, each in its own language — never translated. */
export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English',
  hi: 'हिन्दी',
  gu: 'ગુજરાતી',
  'hi-Latn': 'Hinglish',
}

export function isLocale(value: string): value is Locale {
  return (routing.locales as readonly string[]).includes(value)
}
