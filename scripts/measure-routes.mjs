/**
 * ═════════════════════════════════════════════════════════════════════════════
 * HOW LONG DOES A PAGE ACTUALLY TAKE, WARM, AS A REAL SIGNED-IN USER.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ WITHOUT THIS, EVERY PERFORMANCE CLAIM IN THIS REPOSITORY IS A GUESS.      ║
 * ║                                                                           ║
 * ║ The owner's complaint — "it waits for the server after almost every        ║
 * ║ interaction" — cannot be answered by reading code, and it cannot be        ║
 * ║ answered by the dev server's own log either, because that log mixes        ║
 * ║ first-compile timings (seconds) with warm ones (milliseconds) and prints   ║
 * ║ no aggregate. A single cold sample looks like a catastrophe; a single      ║
 * ║ warm one looks like there is no problem.                                   ║
 * ║                                                                           ║
 * ║ So this WARMS each route first, discards those samples, then measures.     ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ WHAT THESE NUMBERS ARE AND ARE NOT.                                       │
 * │                                                                           │
 * │ They are `next dev` with Turbopack, so they include a module-graph        │
 * │ overhead a production build does not have. They are NOT production        │
 * │ numbers and must never be quoted as such.                                 │
 * │                                                                           │
 * │ They ARE valid for comparing before against after on the same machine,    │
 * │ the same server and the same data — which is the only thing they are used │
 * │ for. Median, not mean: one 3-second outlier from a garbage collection     │
 * │ pause should not move the figure a decision is made on.                   │
 * └───────────────────────────────────────────────────────────────────────────┘
 *
 *   npm run dev                                   # in one terminal
 *   node scripts/measure-routes.mjs               # measure
 *   node scripts/measure-routes.mjs --save before # write scripts/.spike/perf-before.json
 *   node scripts/measure-routes.mjs --compare before
 * ═════════════════════════════════════════════════════════════════════════════
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const APP = process.env.APP_URL ?? 'http://localhost:3000'
const OUT = resolve('scripts/.spike')
const SAMPLES = Number(process.env.SAMPLES ?? 7)
const WARMUP = 3

const args = process.argv.slice(2)
const saveAs = args.includes('--save') ? args[args.indexOf('--save') + 1] : null
const compareTo = args.includes('--compare') ? args[args.indexOf('--compare') + 1] : null

const env = {}
for (const line of readFileSync(resolve('.env.local'), 'utf-8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m) env[m[1]] = m[2].trim()
}
const SUPABASE = env.NEXT_PUBLIC_SUPABASE_URL
const ANON = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
const ref = new URL(SUPABASE).hostname.split('.')[0]

/** The routes worth watching, as the role that sees the most of them. */
const ROUTES = [
  ['/en/dashboard', 'admin'],
  ['/en/questions', 'admin'],
  ['/en/questions/topics', 'admin'],
  ['/en/papers/generate', 'admin'],
  ['/en/history', 'admin'],
  ['/en/exams/live', 'admin'],
  ['/en/evaluate', 'admin'],
  ['/en/settings', 'admin'],
  ['/en/results', 'employee'],
  ['/en/my-exams', 'employee'],
]

const PEOPLE = {
  admin: 'sample-chef@example.com',
  employee: 'sample-employee@example.com',
}

async function cookieFor(email) {
  const s = await (
    await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'Sample-2026!' }),
    })
  ).json()
  if (!s.access_token) throw new Error(`sign-in failed for ${email} — run \`npm run db:sample\``)

  const name = `sb-${ref}-auth-token`
  const encoded = 'base64-' + Buffer.from(JSON.stringify(s)).toString('base64url')
  const parts = []
  for (let i = 0; i < encoded.length; i += 3180) parts.push(encoded.slice(i, i + 3180))
  return parts.length === 1
    ? `${name}=${parts[0]}`
    : parts.map((p, i) => `${name}.${i}=${p}`).join('; ')
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length % 2 ? s[(s.length - 1) / 2] : Math.round((s[s.length / 2 - 1] + s[s.length / 2]) / 2)
}

async function timeOnce(path, cookie) {
  const t = performance.now()
  const res = await fetch(`${APP}${path}`, { headers: { cookie }, redirect: 'manual' })
  const body = await res.text() // drain, or the timing excludes transfer
  return { ms: Math.round(performance.now() - t), status: res.status, bytes: body.length }
}

const alive = await fetch(`${APP}/en/login`, { redirect: 'manual' }).then((r) => r.ok).catch(() => false)
if (!alive) {
  console.error(`\n  No dev server at ${APP}. Run \`npm run dev\` first.\n`)
  process.exit(1)
}

const cookies = {}
for (const [role, email] of Object.entries(PEOPLE)) cookies[role] = await cookieFor(email)

console.log(`\n  ${WARMUP} warm-up requests then ${SAMPLES} measured, per route. Median reported.\n`)

const results = {}
for (const [path, role] of ROUTES) {
  const cookie = cookies[role]

  // Warm-up: compile the route, fill any cache, and throw the numbers away.
  for (let i = 0; i < WARMUP; i++) await timeOnce(path, cookie)

  const samples = []
  let last = null
  for (let i = 0; i < SAMPLES; i++) {
    last = await timeOnce(path, cookie)
    samples.push(last.ms)
  }

  results[path] = {
    role,
    status: last.status,
    kb: Math.round(last.bytes / 1024),
    median: median(samples),
    min: Math.min(...samples),
    max: Math.max(...samples),
  }

  const r = results[path]
  console.log(
    `  ${path.padEnd(24)} ${String(r.median).padStart(5)}ms  ` +
      `(${r.min}–${r.max})  ${String(r.kb).padStart(4)}KB  ${r.status}  [${role}]`,
  )
}

if (saveAs) {
  mkdirSync(OUT, { recursive: true })
  const file = resolve(OUT, `perf-${saveAs}.json`)
  writeFileSync(file, JSON.stringify(results, null, 2) + '\n', 'utf8')
  console.log(`\n  saved → ${file}`)
}

if (compareTo) {
  const file = resolve(OUT, `perf-${compareTo}.json`)
  if (!existsSync(file)) {
    console.error(`\n  no baseline at ${file} — run with --save ${compareTo} first\n`)
    process.exit(1)
  }
  const before = JSON.parse(readFileSync(file, 'utf8'))

  console.log(`\n  ── vs ${compareTo} ${'─'.repeat(46)}`)
  console.log(`  ${'route'.padEnd(24)} ${'before'.padStart(8)} ${'after'.padStart(8)} ${'delta'.padStart(10)}`)
  let totalBefore = 0
  let totalAfter = 0
  for (const [path, after] of Object.entries(results)) {
    const b = before[path]
    if (!b) continue
    totalBefore += b.median
    totalAfter += after.median
    const delta = after.median - b.median
    const pct = Math.round((delta / b.median) * 100)
    console.log(
      `  ${path.padEnd(24)} ${String(b.median).padStart(6)}ms ${String(after.median).padStart(6)}ms ` +
        `${(delta > 0 ? '+' : '') + delta}ms ${pct > 0 ? '+' : ''}${pct}%`,
    )
  }
  const pct = Math.round(((totalAfter - totalBefore) / totalBefore) * 100)
  console.log(
    `  ${'TOTAL'.padEnd(24)} ${String(totalBefore).padStart(6)}ms ${String(totalAfter).padStart(6)}ms ` +
      `${totalAfter - totalBefore > 0 ? '+' : ''}${totalAfter - totalBefore}ms ${pct > 0 ? '+' : ''}${pct}%`,
  )
}

console.log('')
