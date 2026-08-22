/**
 * Runs `supabase db push` against the pooler using the credentials already in
 * .env.local, without linking the CLI.
 *
 * The CLI's normal path needs `supabase link`, which authenticates against the
 * management API and therefore needs a SUPABASE_ACCESS_TOKEN this machine does
 * not have. `--db-url` takes the same route the other scripts in this folder
 * take — a direct pooler connection — while still letting the CLI do the work:
 * it applies only PENDING migrations, in order, and records each in
 * supabase_migrations.schema_migrations itself. Nothing here reimplements that.
 *
 * The password is passed through the argument list built in-process and is
 * never printed. Output is streamed straight through.
 *
 *   node scripts/db-push.mjs            # dry run — lists what WOULD apply
 *   node scripts/db-push.mjs --apply    # actually applies
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

function readEnvLocal() {
  const raw = readFileSync(resolve('.env.local'), 'utf-8')
  const out = {}
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
    if (m) out[m[1]] = m[2].trim()
  }
  return out
}

const env = readEnvLocal()
const ref = new URL(env.NEXT_PUBLIC_SUPABASE_URL).hostname.split('.')[0]
const host = process.env.SUPABASE_DB_HOST ?? 'aws-0-ap-southeast-1.pooler.supabase.com'

if (!env.SUPABASE_DB_PASSWORD) {
  console.error('SUPABASE_DB_PASSWORD is not set in .env.local.')
  process.exit(1)
}

// encodeURIComponent, because a password containing @ : / or ? silently
// truncates the connection string into something that points elsewhere.
const url =
  `postgresql://postgres.${ref}:${encodeURIComponent(env.SUPABASE_DB_PASSWORD)}` +
  `@${host}:5432/postgres`

const apply = process.argv.includes('--apply')

const args = ['supabase', 'db', 'push', '--db-url', url, '--include-all']
if (!apply) args.push('--dry-run')

console.log(`\n  ${apply ? 'APPLYING' : 'DRY RUN'} — project ${ref} via ${host}\n`)

const result = spawnSync('npx', args, {
  stdio: 'inherit',
  shell: true,
})

if (result.status !== 0) {
  console.error(`\n  supabase db push exited ${result.status}\n`)
}
process.exit(result.status ?? 1)
