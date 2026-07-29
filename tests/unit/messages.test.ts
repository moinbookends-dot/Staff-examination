import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

/**
 * Message bundles.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THIS DOES NOT REQUIRE COMPLETE TRANSLATIONS, AND MUST NOT.                │
 * │                                                                           │
 * │ src/lib/i18n/request.ts deep-merges each locale over English, so a key    │
 * │ absent from hi renders in English rather than as a raw key. That is what  │
 * │ makes translating namespace by namespace safe, and a parity check         │
 * │ demanding all 439 keys in every locale would turn a deliberate,           │
 * │ working arrangement into a permanently red build — the kind of check      │
 * │ people learn to ignore, taking the real ones with it.                     │
 * │                                                                           │
 * │ The failure the fallback CANNOT catch is the opposite one: a key that     │
 * │ exists only in a locale file. Rename `sitting.timeLeft` in English and    │
 * │ the Hindi entry keeps its old name, silently never renders, and the       │
 * │ screen quietly reverts to English for that string with nothing to say so. │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

const root = resolve(__dirname, '../..')
const LOCALES = ['hi', 'gu', 'hi-Latn'] as const

type Bundle = { [key: string]: string | Bundle }

function load(locale: string): Bundle {
  return JSON.parse(readFileSync(resolve(root, `messages/${locale}.json`), 'utf8'))
}

/** Every leaf path in a bundle, as `namespace.key`. */
function paths(bundle: Bundle, prefix = ''): string[] {
  return Object.entries(bundle).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key
    return typeof value === 'object' && value !== null ? paths(value, path) : [path]
  })
}

/** The `{placeholders}` a message interpolates. */
function placeholders(message: string): string[] {
  return [...message.matchAll(/\{(\w+)/g)].map((m) => m[1]).sort()
}

function leaf(bundle: Bundle, path: string): string | undefined {
  const value = path.split('.').reduce<unknown>((node, key) => {
    return node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined
  }, bundle)
  return typeof value === 'string' ? value : undefined
}

const english = load('en')
const englishPaths = new Set(paths(english))

describe('message bundles', () => {
  it('has an English bundle with every namespace', () => {
    expect(englishPaths.size).toBeGreaterThan(400)
  })

  describe.each(LOCALES)('%s', (locale) => {
    const bundle = load(locale)

    it('carries no key that English does not', () => {
      const orphans = paths(bundle).filter((p) => !englishPaths.has(p))
      expect(
        orphans,
        `these keys exist only in ${locale} and will never render:\n  ${orphans.join('\n  ')}`,
      ).toEqual([])
    })

    /**
     * A translation that drops or renames a placeholder is worse than an
     * untranslated string: next-intl renders the literal `{score}` to a
     * candidate, or throws for a missing argument. Neither is visible until
     * somebody switches language.
     */
    it('uses the same placeholders as English', () => {
      const mismatched: string[] = []

      for (const path of paths(bundle)) {
        const translated = leaf(bundle, path)
        const source = leaf(english, path)
        if (translated === undefined || source === undefined) continue

        const a = placeholders(source).join(',')
        const b = placeholders(translated).join(',')
        if (a !== b) mismatched.push(`${path}: English has {${a}}, ${locale} has {${b}}`)
      }

      expect(mismatched, mismatched.join('\n  ')).toEqual([])
    })
  })
})
