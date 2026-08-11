/**
 * ═════════════════════════════════════════════════════════════════════════════
 * EVERY CONTROL ON THE SIGNED-OUT SCREENS, MEASURED IN A REAL BROWSER.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ A CLASS NAME IS NOT A SIZE.                                               ║
 * ║                                                                           ║
 * ║ The touch-target work is one CSS rule in globals.css. Asserting that the  ║
 * ║ rule is in the file proves nothing: it can be overridden by a later       ║
 * ║ utility, scoped to a selector no element matches, or silently dropped     ║
 * ║ when the auth layout stops carrying data-auth-surface. The only honest    ║
 * ║ question is what getBoundingClientRect() returns, so that is what this    ║
 * ║ asks — in headless Chrome, over the DevTools Protocol, with no new        ║
 * ║ dependency (Node ships a global WebSocket; Chrome is already installed).  ║
 * ║                                                                           ║
 * ║ It also asks the OTHER question no HTML assertion can answer: does the    ║
 * ║ page scroll sideways. A 320px screen is the real floor — an iPhone SE in  ║
 * ║ a kitchen — and one over-wide element there makes the whole form drift.   ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 * 44px is Apple's Human Interface guideline and Google's Material minimum. It
 * is not a stylistic preference here: getting a password wrong three times on
 * this product locks the account, and the people typing are on phones,
 * one-handed, mid-shift.
 *
 *   npm run dev            # in one terminal
 *   node scripts/check-touch.mjs
 * ═════════════════════════════════════════════════════════════════════════════
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

const APP = process.env.APP_URL ?? 'http://localhost:3000'
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'

/** The minimum both Apple and Google publish. */
const MIN = 44

/*
 * 320 is an iPhone SE and the narrowest phone still in real use; 360 is the
 * commonest Android; 390 is a current iPhone; 768 is the tablet breakpoint,
 * where the auth layout's brand panel has not yet appeared and the form is
 * still the whole page.
 */
const WIDTHS = [320, 360, 390, 768]

/*
 * Every signed-out screen, in every locale, because the labels differ in
 * length and a Gujarati button is not the same width as an English one.
 * verify-email is included in BOTH its shapes — the code form and the
 * ask-for-your-address fallback — because they render different controls.
 */
const ROUTES = []
for (const locale of ['en', 'hi', 'gu']) {
  for (const path of [
    '/login',
    '/register',
    '/forgot-password',
    '/reset-password',
    '/verify-email',
    '/verify-email?email=someone@example.com',
  ]) {
    ROUTES.push(`/${locale}${path}`)
  }
}

let fails = 0
const check = (label, pass, detail = '') => {
  if (!pass) fails++
  console.log(`  ${pass ? 'PASS' : 'FAIL'}  ${label}${detail ? '  — ' + detail : ''}`)
}

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

/*
 * Runs IN THE PAGE. Returns the measurements, not a verdict — the decision
 * stays in Node where it can be printed with context.
 *
 * `type="hidden"` inputs are skipped: they have no box and are not touched.
 * Anything with zero area is skipped too, because a control that is not
 * rendered at this width (the brand panel's, a `hidden md:block`) is not a
 * target that can be missed — it is absent, which is a different question.
 */
const MEASURE = `(() => {
  const out = []
  const nodes = document.querySelectorAll(
    'input:not([type=hidden]), select, textarea, button, a[href]'
  )
  for (const el of nodes) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    const style = getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none') continue
    out.push({
      tag: el.tagName.toLowerCase(),
      id: el.id || null,
      label:
        (el.getAttribute('aria-label') ||
          el.textContent ||
          el.getAttribute('name') ||
          '').trim().slice(0, 40),
      w: Math.round(r.width),
      h: Math.round(r.height),
    })
  }
  return JSON.stringify({
    controls: out,
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  })
})()`

let chrome = null
const profile = mkdtempSync(resolve(tmpdir(), 'touch-'))

try {
  const alive = await fetch(`${APP}/en/login`, { redirect: 'manual' })
    .then((r) => r.ok)
    .catch(() => false)
  if (!alive) {
    console.error(`\n  No dev server at ${APP}. Run \`npm run dev\` first.\n`)
    process.exit(1)
  }

  const port = 9335
  chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      // NOT --hide-scrollbars. A scrollbar occupies real width, and hiding it
      // is exactly how a page that overflows on a phone measures as if it did
      // not. The horizontal-overflow check below depends on this.
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

  /** name → the smallest box that name was ever measured at, and where. */
  const smallest = new Map()
  let measured = 0

  for (const width of WIDTHS) {
    console.log(`\n── ${width}px ${'─'.repeat(Math.max(0, 54 - String(width).length))}`)

    await page.send('Emulation.setDeviceMetricsOverride', {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: width < 768,
    })

    let tooSmall = 0
    let overflowed = 0

    for (const route of ROUTES) {
      const loaded = new Promise((res) => page.on('Page.loadEventFired', res))
      await page.send('Page.navigate', { url: `${APP}${route}` })
      await loaded
      // Fonts settle a beat after load, and a control measured mid-swap is
      // measured at the fallback font's metrics rather than the real ones.
      await sleep(500)

      const result = await page.send('Runtime.evaluate', {
        expression: MEASURE,
        returnByValue: true,
      })
      const { controls, scrollWidth, clientWidth } = JSON.parse(result.result.value)
      measured += controls.length

      for (const c of controls) {
        // A link inside a sentence is not a touch target in the same sense —
        // it is text, and making every inline link 44px tall would space the
        // prose out absurdly. Only standalone controls are held to the rule.
        const inlineLink = c.tag === 'a' && c.h < 30 && c.w < 220
        if (inlineLink) continue

        const key = `${c.tag}#${c.id ?? c.label}`
        const area = Math.min(c.h, c.w)
        const previous = smallest.get(key)
        if (!previous || area < previous.area) {
          smallest.set(key, { area, ...c, route, width })
        }

        if (c.h < MIN) {
          tooSmall++
          console.log(`        ${route} — ${c.tag}${c.id ? '#' + c.id : ''} "${c.label}" ${c.w}×${c.h}`)
        }
      }

      if (scrollWidth > clientWidth) {
        overflowed++
        console.log(`        ${route} — scrolls sideways: ${scrollWidth} > ${clientWidth}`)
      }
    }

    check(`every control is at least ${MIN}px tall`, tooSmall === 0, tooSmall ? `${tooSmall} too small` : '')
    check('nothing scrolls sideways', overflowed === 0, overflowed ? `${overflowed} route(s)` : '')
  }

  // The positive control. If the selector matched nothing — a renamed data
  // attribute, a layout change, a page that 500s — every check above passes
  // vacuously, and this is the only thing that would notice.
  console.log('')
  check(
    'controls were actually found and measured',
    measured > 200,
    `${measured} measurements across ${ROUTES.length} routes × ${WIDTHS.length} widths`,
  )

  const tightest = [...smallest.values()].sort((a, b) => a.area - b.area).slice(0, 5)
  console.log('\n  tightest targets seen:')
  for (const t of tightest) {
    console.log(
      `    ${String(t.w).padStart(4)}×${String(t.h).padEnd(4)} ${t.tag}${t.id ? '#' + t.id : ''} ` +
        `"${t.label}" (${t.route} @ ${t.width}px)`,
    )
  }

  page.close()
} catch (err) {
  fails++
  console.error(`\n  THREW: ${err.message}`)
} finally {
  if (chrome) chrome.kill()
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    /* Chrome sometimes still holds a lock on Windows. A temp dir is not worth failing over. */
  }
}

console.log(fails === 0 ? '\n  ALL CHECKS PASSED\n' : `\n  ${fails} CHECK(S) FAILED\n`)
process.exitCode = fails ? 1 : 0
