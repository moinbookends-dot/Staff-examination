import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'

/**
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ EVERY t('key') CALL SITE RESOLVES TO A REAL MESSAGE.                      │
 * │                                                                           │
 * │ messages.test.ts checks the bundles against each other. Nothing checked   │
 * │ the bundles against the CODE, and that gap shipped a bug:                 │
 * │                                                                           │
 * │   const tr = await getTranslations('reports')                             │
 * │   …                                                                       │
 * │   {result.passed ? tr('passed') : tr('failed')}                           │
 * │                                                                           │
 * │ `reports.passed` exists. `reports.failed` does not. next-intl does not    │
 * │ throw for a missing key and does not render "MISSING_MESSAGE" — use-intl's│
 * │ default getMessageFallback returns the joined key path — so a candidate   │
 * │ who had just failed an exam was shown a red badge reading, literally,     │
 * │ "reports.failed".                                                         │
 * │                                                                           │
 * │ Nothing could see it. tsc cannot: message keys are untyped without        │
 * │ createMessagesDeclaration, which this project does not use. The render    │
 * │ check sweeps for MISSING_MESSAGE and IntlError, and the fallback string   │
 * │ contains neither. And a render check can only ever exercise the branches  │
 * │ its fixture data reaches — the candidate it creates PASSES, so the fail   │
 * │ branch was never rendered at all.                                         │
 * │                                                                           │
 * │ A static scan reaches every branch, including the ones no fixture         │
 * │ produces. That is the whole reason this is a unit test and not another    │
 * │ assertion in render-check.mjs.                                            │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * SCOPE, stated honestly: this resolves keys that are written as plain string
 * literals. Template literals — `t(\`roles.${role}\`)`, `t(\`status.${s}\`)` —
 * are deliberately skipped, because the key is not knowable without running
 * the code. Those are the minority, and the alternative is a check that
 * guesses.
 */

const root = resolve(__dirname, '../..')

type Bundle = { [key: string]: string | Bundle }

const english: Bundle = JSON.parse(readFileSync(resolve(root, 'messages/en.json'), 'utf8'))

function has(path: string): boolean {
  const value = path.split('.').reduce<unknown>((node, key) => {
    return node && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined
  }, english)
  return typeof value === 'string'
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) sourceFiles(full, out)
    else if (/\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/**
 * `const t = useTranslations('sitting')` → { t: 'sitting' }
 *
 * Both the client hook and the server function, awaited or not, and any local
 * name — this codebase routinely binds several per file (`t`, `tc`, `tr`, `ts`),
 * which is exactly how one of them ends up pointed at the wrong namespace.
 */
function bindings(source: string): Map<string, string> {
  const found = new Map<string, string>()
  const re =
    /(?:const|let)\s+(\w+)\s*=\s*(?:await\s+)?(?:useTranslations|getTranslations)\s*\(\s*'([^']+)'\s*\)/g
  for (const m of source.matchAll(re)) found.set(m[1], m[2])
  return found
}

const files = sourceFiles(resolve(root, 'src'))

describe('message keys used in code', () => {
  it('finds translation bindings to check', () => {
    const total = files.reduce((n, f) => n + bindings(readFileSync(f, 'utf8')).size, 0)
    // A floor, so a refactor that silently stops matching cannot make this
    // suite pass by checking nothing at all.
    expect(total).toBeGreaterThan(20)
  })

  it('every literal t(...) key exists in the English bundle', () => {
    const missing: string[] = []

    for (const file of files) {
      const source = readFileSync(file, 'utf8')
      const bound = bindings(source)
      if (bound.size === 0) continue

      for (const [local, namespace] of bound) {
        // `t('a.b')` but never `t(\`a.${b}\`)` — see the scope note above.
        const re = new RegExp(`\\b${local}\\s*\\(\\s*'([^']+)'`, 'g')
        for (const m of source.matchAll(re)) {
          const full = `${namespace}.${m[1]}`
          if (!has(full)) {
            missing.push(`${file.replace(root, '').replace(/\\/g, '/')}: ${local}('${m[1]}') → ${full}`)
          }
        }
      }
    }

    expect(
      missing,
      `these call sites render a raw key path at the user:\n  ${missing.join('\n  ')}`,
    ).toEqual([])
  })
})
