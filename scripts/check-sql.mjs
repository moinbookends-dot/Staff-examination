/**
 * Parse every migration with the REAL Postgres grammar, offline.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHY THIS EXISTS. There is no local Postgres on this machine and no        │
 * │ Docker, so the only way to find a syntax error in a migration used to be  │
 * │ to push it at the hosted database and read the failure. That is a slow    │
 * │ loop and it runs DDL against a real project to answer a question that has │
 * │ nothing to do with real data.                                             │
 * │                                                                           │
 * │ libpg-query is Postgres's own parser compiled to a library, so what it    │
 * │ accepts is exactly what the server accepts. It is a real check, not an    │
 * │ approximation by a hand-written parser.                                   │
 * │                                                                           │
 * │ WHAT IT DOES NOT CHECK, said plainly so nobody trusts it too far: this is │
 * │ GRAMMAR ONLY. A reference to a table that does not exist, a column type   │
 * │ mismatch, a policy naming a function that was never created, a broken     │
 * │ plpgsql body — all parse fine and all fail on apply. Green here means     │
 * │ "this is valid SQL", never "this migration works".                        │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 * Usage: node scripts/check-sql.mjs [file ...]     (defaults to every migration)
 */

import { readFileSync, readdirSync } from 'node:fs'
import { resolve, join, basename } from 'node:path'
// libpg-query 17.x exports `parse` (async) and needs loadModule() first — the
// parser is WASM and is not ready synchronously.
import { parse, loadModule } from 'libpg-query'

await loadModule()

const MIGRATIONS = resolve('supabase/migrations')

const files =
  process.argv.length > 2
    ? process.argv.slice(2).map((f) => resolve(f))
    : readdirSync(MIGRATIONS)
        .filter((f) => f.endsWith('.sql'))
        .sort()
        .map((f) => join(MIGRATIONS, f))

let failed = 0
let statements = 0

for (const file of files) {
  const sql = readFileSync(file, 'utf8')
  try {
    const result = await parse(sql)
    const n = result?.stmts?.length ?? 0
    statements += n
    console.log(`  ok    ${basename(file)}  (${n} statements)`)
  } catch (err) {
    failed += 1
    // The parser reports a byte cursor rather than a line, which is not much
    // use in a 900-line migration. Convert it.
    const pos = typeof err?.cursorPosition === 'number' ? err.cursorPosition : null
    const where = pos === null ? '' : `  line ${sql.slice(0, pos).split('\n').length}`
    console.log(`  FAIL  ${basename(file)}${where}`)
    console.log(`        ${err.message}`)
  }
}

console.log(
  `\n  ${files.length - failed}/${files.length} files parsed, ${statements} statements.`,
)
process.exit(failed === 0 ? 0 : 1)
