import { getRequestConfig } from 'next-intl/server'
import { hasLocale } from 'next-intl'
import { routing } from './routing'

type Messages = Record<string, unknown>

/**
 * Deep merge, base first. A SHALLOW spread would be wrong here: messages are
 * namespaced two or three levels deep, so `{...en, ...hi}` where `hi` has a
 * partial `exam` namespace would replace the whole English `exam` object and
 * lose every key Hindi has not translated yet — turning a partial translation
 * into missing UI.
 */
function deepMerge(base: Messages, override: Messages): Messages {
  const out: Messages = { ...base }

  for (const [key, value] of Object.entries(override)) {
    const existing = out[key]
    if (
      value && typeof value === 'object' && !Array.isArray(value) &&
      existing && typeof existing === 'object' && !Array.isArray(existing)
    ) {
      out[key] = deepMerge(existing as Messages, value as Messages)
    } else if (value !== undefined && value !== '') {
      // Empty strings are treated as untranslated so a placeholder entry in a
      // translation file does not blank out working English copy.
      out[key] = value
    }
  }

  return out
}

/**
 * Per-request i18n configuration.
 *
 * English is authoritative: every key exists there first, and anything missing
 * in another locale falls back to English rather than rendering a raw key. For
 * staff being examined in a second language, an untranslated-but-readable
 * string beats `exam.timer.label` every time.
 *
 * timeZone is pinned to Asia/Kolkata so exam windows and result timestamps
 * render in outlet-local wall-clock time regardless of server region.
 */
export default getRequestConfig(async ({ requestLocale }) => {
  const requested = await requestLocale
  const locale = hasLocale(routing.locales, requested) ? requested : routing.defaultLocale

  const fallback = (await import(`../../../messages/${routing.defaultLocale}.json`))
    .default as Messages

  const messages =
    locale === routing.defaultLocale
      ? fallback
      : deepMerge(fallback, (await import(`../../../messages/${locale}.json`)).default as Messages)

  return {
    locale,
    messages,
    timeZone: 'Asia/Kolkata',
  }
})
