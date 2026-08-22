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
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THREE LOCALES, NOT FOUR. HINGLISH WAS REMOVED, AND THE REASON IS THE      │
 * │ QUESTION BANK RATHER THAN THIS FILE.                                      │
 * │                                                                           │
 * │ 'hi-Latn' — Hindi in Latin script — shipped here from M7 and was a        │
 * │ defensible fourth UI language while candidates sat exams in the app. The  │
 * │ new examination system stores every question in exactly three languages   │
 * │ (en, hi, gu) and refuses to activate one that is missing any of them, so  │
 * │ a fourth UI locale would be a language a chef could switch the app into   │
 * │ and then never see a question paper in.                                   │
 * │                                                                           │
 * │ Removing it here is only half. profiles.preferred_locale still has a      │
 * │ CHECK admitting 'hi-Latn' (0003), and a profile carrying it would route   │
 * │ to a locale that no longer exists — migration 0053 moves those rows to    │
 * │ 'hi' and tightens the constraint. Neither half is safe alone.             │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
export const routing = defineRouting({
  locales: ['en', 'hi', 'gu'],
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
}

export function isLocale(value: string): value is Locale {
  return (routing.locales as readonly string[]).includes(value)
}
