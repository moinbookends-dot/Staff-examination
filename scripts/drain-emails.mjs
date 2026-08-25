/**
 * Drain email_outbox from the command line.
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ THIS CALLS THE ROUTE RATHER THAN REIMPLEMENTING THE DRAIN.                │
 * │                                                                           │
 * │ The obvious shape for this file was a standalone runner with its own      │
 * │ Supabase and Resend clients. It cannot be: the drain and its templates    │
 * │ are TypeScript with extensionless imports, which plain Node cannot        │
 * │ resolve — and rewriting them in JS here would leave two implementations   │
 * │ of the retry and cap rules to drift apart. The one that matters would be  │
 * │ the one nobody tested.                                                    │
 * │                                                                           │
 * │ So this exercises exactly what the cron exercises, which also makes it a  │
 * │ genuine test of the endpoint's auth. Same convention as check-render.mjs  │
 * │ and the other scripts: talk to a running server.                          │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 *   npm run start                              # or npm run dev
 *   node scripts/drain-emails.mjs --dry-run    # see who would receive what
 *   node scripts/drain-emails.mjs --batch 5    # send, five at a time
 *
 * --dry-run is the point of this script. The queue held 1,369 rows addressed
 * to ninety-odd people before anything could send; being able to read the list
 * without sending is what makes the first live run safe.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const env = {}
for (const line of readFileSync(resolve('.env.local'), 'utf-8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m) env[m[1]] = m[2].trim()
}

const APP = process.env.APP_URL ?? env.APP_URL ?? 'http://localhost:3000'
const SECRET = process.env.CRON_SECRET ?? env.CRON_SECRET

if (!SECRET) {
  console.error('\n  CRON_SECRET is not set in .env.local — the endpoint would refuse this call.\n')
  process.exit(1)
}

const argv = process.argv.slice(2)
const dryRun = argv.includes('--dry-run')
const batchAt = argv.indexOf('--batch')
const batch = batchAt >= 0 ? Number(argv[batchAt + 1]) : null

const url = new URL('/api/cron/drain-email', APP)
if (dryRun) url.searchParams.set('dryRun', '1')
if (batch) url.searchParams.set('batch', String(batch))

console.log(`\n  ${dryRun ? 'DRY RUN — nothing will be sent' : 'LIVE — mail will be sent'}`)
console.log(`  ${url.origin}${url.pathname}\n`)

let response
try {
  response = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${SECRET}` },
  })
} catch (cause) {
  console.error(`  Could not reach ${APP} — is the server running?`)
  console.error(`  ${cause instanceof Error ? cause.message : cause}\n`)
  process.exit(1)
}

if (response.status === 401) {
  console.error('  401 Unauthorized — CRON_SECRET here does not match the server’s.\n')
  process.exit(1)
}

const body = await response.json().catch(() => null)

if (!response.ok) {
  // A non-200 means the QUEUE could not be read, not that an email failed.
  console.error(`  ${response.status}: ${body?.detail ?? body?.error ?? 'unknown error'}\n`)
  process.exit(1)
}

if (dryRun) {
  if (body.previewed.length === 0) {
    console.log('  nothing due to send.')
  } else {
    console.log(`  would send ${body.previewed.length}:\n`)
    for (const p of body.previewed) {
      console.log(`    ${String(p.to).padEnd(40)} [${p.locale}] ${p.subject}`)
    }
  }
} else {
  console.log(`  attempted ${body.attempted} · sent ${body.sent} · failed ${body.failed}`)
  for (const f of body.failures ?? []) {
    console.log(`    FAILED ${f.to}: ${f.error}`)
  }
}

if (body.skippedByCap > 0) {
  console.log(`\n  held back by the daily cap: ${body.skippedByCap} (delayed, not dropped)`)
}
console.log(`  remaining quota today: ${body.remainingToday}\n`)

// Failures are recorded on their rows, but a job that never surfaces them is a
// job nobody notices breaking.
process.exit((body.failed ?? 0) > 0 ? 1 : 0)
