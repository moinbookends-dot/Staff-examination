/**
 * ═════════════════════════════════════════════════════════════════════════════
 * Screenshot an authenticated screen, so somebody can LOOK at it.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ ASSERTING ON HTML IS NOT SEEING THE PAGE.                                 ║
 * ║                                                                           ║
 * ║ scripts/pdf-to-png.mjs exists because three separate footer bugs produced ║
 * ║ perfectly valid PDFs and passed every text assertion. The same trap is    ║
 * ║ open on a web page: `expect(html).toContain('30 questions')` passes just  ║
 * ║ as happily when the table has collapsed, the mobile cards are stacked     ║
 * ║ behind the desktop table, or Devanagari has fallen back to tofu.          ║
 * ║                                                                           ║
 * ║ So this drives real Chrome and writes real PNGs.                          ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * NO NEW DEPENDENCIES. Chrome is already installed, and Node 22+ ships a global
 * WebSocket, so the DevTools Protocol is reachable directly. Adding Playwright
 * to take a screenshot would pull a browser download and a dependency tree into
 * a repository that needs neither.
 *
 * Output goes to scripts/.spike/, which .gitignore already covers — rendered
 * samples are regenerated on demand and are never worth committing.
 *
 *   node scripts/screenshot-ui.mjs /en/questions
 *   node scripts/screenshot-ui.mjs /en/questions --role=editor --seed=30
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { readFileSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import pg from 'pg'

const APP = process.env.APP_URL ?? 'http://localhost:3000'
const OUT = resolve('scripts/.spike')

const args = process.argv.slice(2)
const rawPath = args.find((a) => !a.startsWith('--')) ?? '/en/questions'

/*
 * ┌───────────────────────────────────────────────────────────────────────────┐
 * │ GIT BASH REWRITES A LEADING-SLASH ARGUMENT INTO A WINDOWS PATH.           │
 * │                                                                           │
 * │ MSYS path conversion turns `/en/questions` into something like            │
 * │ `C:/Program Files/Git/en/questions` before node ever sees it, and the URL │
 * │ built from it is rejected by CDP with the wonderfully unhelpful           │
 * │ "Cannot navigate to invalid URL".                                         │
 * │                                                                           │
 * │ Caught here rather than left to be rediscovered, because the symptom      │
 * │ points at Chrome and the cause is the shell.                              │
 * │                                                                           │
 * │   MSYS_NO_PATHCONV=1 node scripts/screenshot-ui.mjs /en/questions         │
 * │   node scripts/screenshot-ui.mjs //en/questions                           │
 * └───────────────────────────────────────────────────────────────────────────┘
 */
if (/^[A-Za-z]:[\\/]/.test(rawPath)) {
  console.error(
    `\n  The route argument arrived as "${rawPath}".\n` +
      `  Git Bash rewrote it. Re-run with MSYS_NO_PATHCONV=1, or use a leading //.\n`,
  )
  process.exit(2)
}

// A doubled leading slash is the other Git Bash escape; normalise it back.
const path = rawPath.replace(/^\/\//, '/')
const role = (args.find((a) => a.startsWith('--role=')) ?? '--role=editor').split('=')[1]
const seed = Number((args.find((a) => a.startsWith('--seed=')) ?? '--seed=0').split('=')[1])

const CHROME =
  process.env.CHROME_PATH ??
  'C:/Program Files/Google/Chrome/Application/chrome.exe'

/** The widths DESIGN.md names: desktop, tablet, phone. */
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 1200 },
  { name: 'tablet', width: 768, height: 1100 },
  { name: 'mobile', width: 390, height: 1200 },
]

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

const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST ?? 'aws-0-ap-southeast-1.pooler.supabase.com',
  port: 5432,
  user: `postgres.${ref}`,
  password: env.SUPABASE_DB_PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
})

const made = []
const TAG = `shot-${Date.now()}`

/** A signed-in user of `role`, returning the cookie parts the app issues. */
async function makeUser(roleKey) {
  const email = `${TAG}-${roleKey}@example.com`
  const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: env.SUPABASE_SECRET_KEY,
      Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email, password: 'screenshot-pw-1', email_confirm: true,
      user_metadata: { full_name: 'Screenshot User', locale: 'en' },
    }),
  })
  if (!res.ok) throw new Error(`create user: ${res.status}`)
  const id = (await res.json()).id
  made.push(id)

  await db.query(`update public.profiles set approval_status='approved' where id=$1`, [id])
  await db.query(
    `insert into public.user_roles (user_id, role_id)
     select $1, id from public.roles where key=$2 and company_id is null on conflict do nothing`,
    [id, roleKey],
  )

  const session = await (
    await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: 'screenshot-pw-1' }),
    })
  ).json()
  if (!session.access_token) throw new Error('sign-in failed')

  // Encoded exactly as @supabase/ssr writes it: base64URL, chunked at 3180.
  const name = `sb-${ref}-auth-token`
  const encoded = 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url')
  const parts = []
  for (let i = 0; i < encoded.length; i += 3180) parts.push(encoded.slice(i, i + 3180))

  return {
    token: session.access_token,
    cookies: parts.length === 1
      ? [{ name, value: parts[0] }]
      : parts.map((p, i) => ({ name: `${name}.${i}`, value: p })),
  }
}

// ── A minimal CDP client ─────────────────────────────────────────────────────
let nextId = 1

function connect(url) {
  const ws = new WebSocket(url)
  const pending = new Map()
  const listeners = new Map()

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve: res, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else res(msg.result)
    } else if (msg.method && listeners.has(msg.method)) {
      listeners.get(msg.method).forEach((fn) => fn(msg.params))
    }
  })

  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', () => rej(new Error(`cannot connect to ${url}`)))
  })

  return {
    ready,
    send(method, params = {}) {
      const id = nextId++
      return new Promise((res, rej) => {
        pending.set(id, { resolve: res, reject: rej })
        ws.send(JSON.stringify({ id, method, params }))
      })
    },
    on(method, fn) {
      if (!listeners.has(method)) listeners.set(method, [])
      listeners.get(method).push(fn)
    },
    close: () => ws.close(),
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let chrome
const profile = resolve(tmpdir(), `chrome-shot-${Date.now()}`)

try {
  await db.connect()
  mkdirSync(OUT, { recursive: true })

  const user = await makeUser(role)
  console.log(`\n  signed in as ${role}`)

  // ── Optionally seed the bank, so the screen has something to render ──────
  if (seed > 0) {
    const brand = (await db.query(`select id from public.brands where deleted_at is null order by name limit 1`)).rows[0]
    const topic = (await db.query(`select slug from public.question_topics where deleted_at is null limit 1`)).rows[0].slug

    const stems = [
      'At what internal temperature is poultry considered safe to serve',
      'Which shelf should raw fish be stored on in a walk-in cooler',
      'How long may cooked rice be held in the danger zone',
      'What is the correct dilution for sanitiser in a three-sink setup',
      'Which allergen must be declared when frying in shared oil',
    ]

    const rows = Array.from({ length: seed }, (_, i) => ({
      externalId: `${TAG}-${i}`,
      difficulty: ['easy', 'medium', 'hard'][i % 3],
      qtype: i % 4 === 3 ? 'short_answer' : 'mcq',
      status: i % 7 === 6 ? 'draft' : 'active',
      topicSlug: topic,
      correctOption: i % 4 === 3 ? null : ['A', 'B', 'C', 'D'][i % 4],
      referenceTitle: null,
      referencePage: null,
      texts: [{
        locale: 'en',
        question: `${stems[i % stems.length]} (${i + 1})?`,
        optionA: i % 4 === 3 ? null : '4 °C',
        optionB: i % 4 === 3 ? null : '63 °C',
        optionC: i % 4 === 3 ? null : '74 °C',
        optionD: i % 4 === 3 ? null : '100 °C',
        answerText: i % 4 === 3 ? '74 °C for fifteen seconds' : null,
        explanation: null,
      }],
    }))

    const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1/rpc/bank_import_commit`, {
      method: 'POST',
      headers: {
        apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
        Authorization: `Bearer ${user.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ p_brand_id: brand.id, p_rows: rows }),
    })
    if (!res.ok) throw new Error(`seed failed: ${res.status} ${await res.text()}`)
    console.log(`  seeded ${seed} questions`)
  }

  // ── Drive Chrome ─────────────────────────────────────────────────────────
  const port = 9333
  chrome = spawn(CHROME, [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    'about:blank',
  ], { stdio: 'ignore' })

  // Poll for the debugging endpoint rather than sleeping a guessed interval.
  let version = null
  for (let i = 0; i < 40 && !version; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
    } catch { await sleep(250) }
  }
  if (!version) throw new Error('Chrome did not expose its debugging port')

  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json()
  const page = connect(target.webSocketDebuggerUrl)
  await page.ready

  await page.send('Page.enable')
  await page.send('Network.enable')

  // The session cookie, set before the first navigation so the very first
  // request is authenticated and never bounces through /login.
  for (const c of user.cookies) {
    await page.send('Network.setCookie', {
      name: c.name, value: c.value, domain: 'localhost', path: '/',
    })
  }

  const written = []

  for (const vp of VIEWPORTS) {
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: vp.width,
      height: vp.height,
      deviceScaleFactor: 1,
      mobile: vp.name === 'mobile',
    })

    const loaded = new Promise((res) => page.on('Page.loadEventFired', res))
    await page.send('Page.navigate', { url: `${APP}${path}` })
    await loaded
    // Fonts and the Devanagari/Gujarati fallbacks settle a beat after load.
    await sleep(1200)

    const shot = await page.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
    })

    const file = resolve(OUT, `${path.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '')}-${vp.name}.png`)
    writeFileSync(file, Buffer.from(shot.data, 'base64'))
    written.push(file)
    console.log(`  ${vp.name.padEnd(8)} ${vp.width}px → ${file}`)
  }

  page.close()
  console.log(`\n  ${written.length} screenshots written. Look at them.\n`)
} catch (err) {
  console.error(`\n  FAILED: ${err.message}\n`)
  process.exitCode = 1
} finally {
  if (chrome) chrome.kill()
  if (seed > 0) {
    await db.query(`delete from public.bank_questions where external_id like $1`, [`${TAG}-%`])
  }
  for (const id of made) {
    await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL}/auth/v1/admin/users/${id}`, {
      method: 'DELETE',
      headers: { apikey: env.SUPABASE_SECRET_KEY, Authorization: `Bearer ${env.SUPABASE_SECRET_KEY}` },
    })
  }
  const left = await db.query(
    `select count(*)::int n from public.bank_questions where external_id like $1`, [`${TAG}-%`])
  console.log(`  cleaned up: ${made.length} users, ${left.rows[0].n} seeded rows left behind`)
  await db.end()
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* chrome may still hold it */ }
}
