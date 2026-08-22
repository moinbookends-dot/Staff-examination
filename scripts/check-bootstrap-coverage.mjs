/**
 * ═════════════════════════════════════════════════════════════════════════════
 * DOES supabase/tests/bootstrap.sql STAND UP EVERYTHING THE MIGRATIONS NEED?
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ THIS EXISTS BECAUSE THE ANSWER WAS NO FOR FIFTEEN MIGRATIONS, AND THE     ║
 * ║ SYMPTOM POINTED SOMEWHERE ELSE.                                           ║
 * ║                                                                           ║
 * ║ A hosted Supabase project ships `auth`, `storage` and friends. A bare     ║
 * ║ postgres:17 container ships none of them, so bootstrap.sql has to build   ║
 * ║ the subset the migrations touch. 0048 began using storage.buckets and     ║
 * ║ storage.objects and bootstrap.sql was never updated — so the CI step      ║
 * ║ "Replay every migration from empty" died on 0048 with                     ║
 * ║ `schema "storage" does not exist`, and every RLS suite after it never     ║
 * ║ ran. The failure reads like a migration problem, not a missing fixture.   ║
 * ║                                                                           ║
 * ║ Running this is instant and needs no database, so the next 0048 is caught ║
 * ║ by `npm run check:sql`-speed feedback rather than by a CI job nobody      ║
 * ║ reads the middle of.                                                      ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 *   node scripts/check-bootstrap-coverage.mjs
 * ═════════════════════════════════════════════════════════════════════════════
 */
import { readFileSync, readdirSync } from 'node:fs'

/**
 * The schemas a hosted project provides and a container does not.
 *
 * An explicit list, because "anything before a dot" also matches every table
 * alias and every `attempts.read_all` permission string in the file — a
 * scanner that guesses produces a page of noise and gets ignored.
 */
const PROVIDED_BY_SUPABASE = [
  'auth', 'storage', 'vault', 'extensions', 'graphql', 'graphql_public',
  'realtime', 'cron', 'net', 'pgbouncer', 'supabase_functions',
]

/**
 * Comments AND string literals, so only real code is scanned.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THE STRING-LITERAL PASS IS NOT TIDINESS. WITHOUT IT THIS REPORTED A       │
 * │ MISSING `auth.hook`, WHICH IS NOT AN OBJECT AND NEVER WAS.                │
 * │                                                                           │
 * │ 0004 carries the sentence "Register in config.toml under                  │
 * │ [auth.hook.custom_access_token]" inside a COMMENT ON string. A scanner    │
 * │ that reads prose as code sends somebody to build a fixture for a thing    │
 * │ that does not exist — and the next real gap gets lost among the noise.    │
 * │                                                                           │
 * │ Ordinary literals only. Dollar-quoted bodies stay, because that is where  │
 * │ auth.uid() actually lives; the '…' strings inside them are error messages │
 * │ and are correctly dropped by the same pass.                               │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
function code(sql) {
  return sql
    // Line comments first: an apostrophe in prose ("a chef's paper") would
    // otherwise unbalance the literal stripping that follows.
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    // '…', with '' as the escaped quote.
    .replace(/'(?:[^']|'')*'/g, " '' ")
}

/** `schema.object` occurrences for one schema, found without a regex. */
function objectsFor(sql, schema) {
  const found = new Set()
  const needle = schema + '.'
  let i = sql.indexOf(needle)

  while (i !== -1) {
    // A preceding identifier character means this is `something_auth.x`, or a
    // qualified column like `my_auth.uid` — not the schema.
    const before = i === 0 ? '' : sql[i - 1]
    if (!/[A-Za-z0-9_.]/.test(before)) {
      let j = i + needle.length
      let name = ''
      while (j < sql.length && /[a-z0-9_]/i.test(sql[j])) name += sql[j++]
      if (name) found.add(schema + '.' + name.toLowerCase())
    }
    i = sql.indexOf(needle, i + 1)
  }

  return found
}

const bootstrap = code(readFileSync('supabase/tests/bootstrap.sql', 'utf8'))
const files = readdirSync('supabase/migrations').filter((f) => f.endsWith('.sql')).sort()

/** object → the first migration that used it. */
const used = new Map()
for (const file of files) {
  const sql = code(readFileSync(`supabase/migrations/${file}`, 'utf8'))
  for (const schema of PROVIDED_BY_SUPABASE) {
    for (const obj of objectsFor(sql, schema)) {
      if (!used.has(obj)) used.set(obj, file)
    }
  }
}

console.log('\n  Supabase-provided objects the migrations use:\n')

let missing = 0
for (const [obj, first] of [...used].sort()) {
  const schema = obj.split('.')[0]
  const provided =
    objectsFor(bootstrap, schema).has(obj) ||
    // A function called but never named as a definition still counts if the
    // schema itself is built and the object appears anywhere in the file.
    bootstrap.includes(obj)

  if (!provided) missing++
  console.log(
    `    ${provided ? 'ok      ' : 'MISSING '} ${obj.padEnd(26)} first used in ${first.replace(/^\d+_/, '')}`,
  )
}

if (used.size === 0) {
  // Guard against the scanner silently matching nothing and reporting success —
  // every one of these migrations calls auth.uid() at least once.
  console.error('\n  The scanner found NO references at all, which cannot be right.')
  console.error('  auth.uid() alone appears in dozens of migrations. Fix the scanner.\n')
  process.exit(2)
}

console.log(
  missing === 0
    ? `\n  bootstrap.sql stands up all ${used.size} — the migration replay has what it needs.\n`
    : `\n  ${missing} of ${used.size} NOT PROVIDED. The replay stops at the first one.\n`,
)
process.exitCode = missing ? 1 : 0
