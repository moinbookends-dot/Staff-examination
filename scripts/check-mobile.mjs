/**
 * ═══════════════════════════════════════════════════════════════════════════
 * Every screen, signed in, at phone width.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ check-touch.mjs COVERS THE SIGNED-OUT SCREENS. THIS COVERS THE REST.      ║
 * ║                                                                           ║
 * ║ Those six pages are the ones a stranger can reach, so they were checked   ║
 * ║ first. But the app is now installable, and staff run the whole thing from ║
 * ║ a home-screen icon — so every authenticated screen has to survive 320px   ║
 * ║ too, and nothing was measuring them.                                      ║
 * ║                                                                           ║
 * ║ THREE FAILURES, ALL OF WHICH LOOK FINE IN A DESKTOP BROWSER:              ║
 * ║                                                                           ║
 * ║  1. Horizontal overflow. A table or a long unbroken string widens the     ║
 * ║     document past the viewport, and the whole page slides sideways.       ║
 * ║  2. Targets under 44px. The floor Apple and Google both publish, and the  ║
 * ║     difference between a tap and three taps with wet hands.               ║
 * ║  3. Content trapped under the fixed tab bar, which covers the last ~5rem  ║
 * ║     of every page and is invisible to any check that only reads markup.   ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 *   npm run start   (or npm run dev)
 *   node scripts/check-mobile.mjs
 *   node scripts/check-mobile.mjs --role=employee
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const APP = process.env.APP_URL ?? 'http://localhost:3000'
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'

/** The floor both platforms publish. */
const MIN = 44

/** 320 is an iPhone SE; 390 is a current iPhone. Both still in real use. */
const WIDTHS = [320, 390]

const env = {}
for (const line of readFileSync(resolve('.env.local'), 'utf-8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m) env[m[1]] = m[2].trim()
}
const URL_ = env.NEXT_PUBLIC_SUPABASE_URL
const PUB = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
const ref = new URL(URL_).hostname.split('.')[0]

const ROLE = (process.argv.find((a) => a.startsWith('--role='))?.split('=')[1] ?? 'admin').trim()
const ACCOUNTS = {
  admin: 'sample-superadmin@example.com',
  employee: 'sample-employee@example.com',
  hr: 'sample-hr@example.com',
}
const PASSWORD = 'Sample-2026!'

/**
 * Every authenticated screen. A route needing an id uses one resolved at run
 * time; where none exists the route is skipped and SAID to be skipped, because
 * a silently-absent check reads exactly like a passing one.
 */
const STATIC_ROUTES = [
  '/dashboard',
  '/my-exams',
  '/results',
  '/exams/live',
  '/exams/upcoming',
  '/exams/closed',
  '/questions',
  '/questions/new',
  '/questions/import',
  '/questions/topics',
  '/papers/generate',
  '/history',
  '/evaluate',
  '/reports',
  '/users/approvals',
  '/settings',
  '/verify',
]

let fails = 0
const problems = []
const check = (pass, label, detail) => {
  if (pass) return
  fails += 1
  problems.push({ label, detail })
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function connect(url) {
  const ws = new WebSocket(url)
  const pending = new Map()
  let id = 0

  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve: res, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else res(msg.result)
    }
  })

  const ready = new Promise((res, rej) => {
    ws.addEventListener('open', res)
    ws.addEventListener('error', () => rej(new Error(`cannot connect to ${url}`)))
  })

  return {
    ready,
    /*
     * Every call is bounded.
     *
     * Without a timeout a dropped CDP reply hangs the whole run forever, and
     * the symptom is a script that simply stops printing halfway down the
     * route list — which reads exactly like a page that never loads. It cost
     * an hour of looking at the wrong thing. A rejection names the method.
     */
    send(method, params = {}, timeoutMs = 20_000) {
      const msgId = ++id
      return new Promise((res, rej) => {
        const timer = setTimeout(() => {
          pending.delete(msgId)
          rej(new Error(`CDP timeout after ${timeoutMs}ms: ${method}`))
        }, timeoutMs)

        pending.set(msgId, {
          resolve: (value) => {
            clearTimeout(timer)
            res(value)
          },
          reject: (err) => {
            clearTimeout(timer)
            rej(err)
          },
        })
        ws.send(JSON.stringify({ id: msgId, method, params }))
      })
    },
    close: () => ws.close(),
  }
}

/*
 * What the page is asked about itself, once it has settled.
 *
 * Measured in the page rather than inferred from the HTML: a class name is not
 * a size, and whether an element ends up under the tab bar depends on layout,
 * not markup. `getBoundingClientRect` is the only honest source.
 */
const PROBE = `(() => {
  const doc = document.documentElement
  const overflow = Math.max(0, doc.scrollWidth - doc.clientWidth)

  // What is actually sticking out, so a failure names something fixable.
  const widest = []
  if (overflow > 0) {
    for (const el of document.querySelectorAll('body *')) {
      const r = el.getBoundingClientRect()
      if (r.width === 0 || r.height === 0) continue
      if (r.right > doc.clientWidth + 1) {
        widest.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className && String(el.className).slice(0, 60)) || '',
          right: Math.round(r.right),
          text: (el.textContent || '').trim().slice(0, 40),
        })
      }
    }
    widest.sort((a, b) => b.right - a.right)
  }

  // Interactive things, and how big they actually are.
  const small = []
  const seen = new Set()
  for (const el of document.querySelectorAll('a, button, [role="button"], [role="radio"], input:not([type="hidden"]), select, textarea, summary')) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    const style = getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none') continue
    if (el.closest('[aria-hidden="true"]')) continue
    if (el.disabled) continue

    /*
     * A radio or checkbox is 16-24px by design and always will be — enlarging
     * the dot itself looks broken. What must be 44px is the LABEL wrapping it,
     * which is what a finger actually lands on. So the control is measured
     * through its label where it has one.
     */
    let box = r
    const role = el.getAttribute('role')
    if (el.type === 'radio' || el.type === 'checkbox' || role === 'radio' || role === 'checkbox') {
      const label = el.closest('label') || (el.id && document.querySelector('label[for="' + el.id + '"]'))
      if (label) {
        const lr = label.getBoundingClientRect()
        if (Math.min(lr.width, lr.height) >= 44 - 0.5) continue
        box = lr
      }
    }

    const name = (el.getAttribute('aria-label') || el.textContent || el.getAttribute('name') || el.tagName).trim().replace(/\\s+/g, ' ').slice(0, 44)
    if (Math.min(box.width, box.height) < ${MIN} - 0.5) {
      const key = name + Math.round(box.width) + 'x' + Math.round(box.height)
      if (!seen.has(key)) {
        seen.add(key)
        small.push({ name, w: Math.round(box.width), h: Math.round(box.height) })
      }
    }
  }

  return JSON.stringify({ overflow, widest: widest.slice(0, 3), small: small.slice(0, 6) })
})()`

// ── Sign in and build the cookie @supabase/ssr expects ──────────────────────
const email = ACCOUNTS[ROLE] ?? ACCOUNTS.admin

const session = await (
  await fetch(`${URL_}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: PUB, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  })
).json()

if (!session.access_token) {
  console.error(`\n  Could not sign in as ${email}: ${session.error_description ?? session.msg}\n`)
  process.exit(1)
}

const cookieName = `sb-${ref}-auth-token`
const encoded = 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url')
const cookieParts = []
for (let i = 0; i < encoded.length; i += 3180) cookieParts.push(encoded.slice(i, i + 3180))

let chrome = null
const profile = mkdtempSync(resolve(tmpdir(), 'mobile-'))

try {
  const alive = await fetch(`${APP}/en/login`, { redirect: 'manual' })
    .then((r) => r.ok)
    .catch(() => false)
  if (!alive) {
    console.error(`\n  No server at ${APP}. Run \`npm run start\` first.\n`)
    process.exit(1)
  }

  const port = 9337
  chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      // NOT --hide-scrollbars: a scrollbar takes real width, and hiding it is
      // how a page that overflows measures as though it does not.
      'about:blank',
    ],
    { stdio: 'ignore' },
  )

  let version = null
  for (let i = 0; i < 40 && !version; i++) {
    try {
      version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
    } catch {
      await sleep(250)
    }
  }
  if (!version) throw new Error('Chrome did not expose its debugging port')

  const target = await (
    await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })
  ).json()
  const page = connect(target.webSocketDebuggerUrl)
  await page.ready
  await page.send('Page.enable')
  await page.send('Runtime.enable')
  await page.send('Network.enable')

  const origin = new URL(APP)
  for (const [i, value] of cookieParts.entries()) {
    await page.send('Network.setCookie', {
      name: cookieParts.length === 1 ? cookieName : `${cookieName}.${i}`,
      value,
      domain: origin.hostname,
      path: '/',
    })
  }

  // Ids for the routes that need one, discovered rather than hard-coded.
  const routes = [...STATIC_ROUTES]
  const skipped = []

  console.log(`\n  Signed in as ${email}  ·  ${APP}\n`)

  for (const width of WIDTHS) {
    console.log(`── ${width}px ${'─'.repeat(56 - String(width).length)}`)

    await page.send('Emulation.setDeviceMetricsOverride', {
      width,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    })

    for (const route of routes) {
      const url = `${APP}/en${route}`
      /*
       * location.href, not Page.navigate.
       *
       * Page.navigate's reply is tied to the navigation committing, and under
       * device emulation it sometimes never arrives — the run then hangs on a
       * CDP call rather than on the page, which is indistinguishable from a
       * broken route until you time the routes separately (they were fine).
       * An assignment returns immediately and readiness is polled below.
       */
      await page.send('Runtime.evaluate', {
        expression: `location.href = ${JSON.stringify(url)}`,
      })

      /*
       * Wait for the document to actually be ready, then settle briefly.
       *
       * This was a flat sleep(700), and it was not enough: a cold production
       * server takes several seconds on its first render, so the probe ran
       * against a half-built page and the run desynchronised — which surfaced
       * as the script silently stopping partway down the route list.
       */
      for (let i = 0; i < 40; i++) {
        const { result } = await page.send('Runtime.evaluate', {
          expression: 'document.readyState',
          returnByValue: true,
        })
        if (result?.value === 'complete') break
        await sleep(250)
      }
      // The shell streams; measuring mid-stream reports phantom overflow from
      // a half-laid-out grid.
      await sleep(400)

      const { result } = await page.send('Runtime.evaluate', {
        expression: PROBE,
        returnByValue: true,
        awaitPromise: false,
      })

      if (!result?.value) {
        skipped.push(`${route} @ ${width} — no result`)
        continue
      }

      const probe = JSON.parse(result.value)
      const bits = []

      if (probe.overflow > 0) {
        const w = probe.widest[0]
        bits.push(`overflows ${probe.overflow}px${w ? ` (${w.tag}${w.cls ? '.' + w.cls.split(' ')[0] : ''} "${w.text}")` : ''}`)
        check(false, `${route} @ ${width}px`, bits[bits.length - 1])
      }

      if (probe.small.length > 0) {
        const list = probe.small.map((s) => `${s.name} ${s.w}×${s.h}`).join(', ')
        bits.push(`${probe.small.length} target(s) under ${MIN}px: ${list}`)
        check(false, `${route} @ ${width}px`, bits[bits.length - 1])
      }

      console.log(`  ${bits.length === 0 ? '✅' : '❌'} ${route}${bits.length ? ' — ' + bits.join(' · ') : ''}`)
    }
    console.log('')
  }

  page.close()

  if (skipped.length > 0) {
    console.log(`  Skipped: ${skipped.join(', ')}\n`)
  }

  if (fails === 0) {
    console.log('  Mobile check passed — no overflow, every target at least 44px.\n')
  } else {
    console.log(`  ${fails} problem(s):\n`)
    for (const p of problems) console.log(`    ${p.label}\n      ${p.detail}`)
    console.log('')
  }
} finally {
  if (chrome) chrome.kill()
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    /* Windows holds the profile briefly after Chrome exits; harmless. */
  }
}

process.exitCode = fails === 0 ? 0 : 1
