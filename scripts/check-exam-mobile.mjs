/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The exam, sat on a phone. For real.
 *
 * ╔═══════════════════════════════════════════════════════════════════════════╗
 * ║ WHY THIS EXISTS SEPARATELY FROM check-mobile.mjs.                         ║
 * ║                                                                           ║
 * ║ That script walks every authenticated route and measures the layout. It   ║
 * ║ cannot cover /attempt/[id], because that route needs a LIVE ATTEMPT — a   ║
 * ║ paper, an exam, an assignment and a started attempt — and the exam screen ║
 * ║ is the one screen where a layout bug costs somebody their result rather   ║
 * ║ than their patience.                                                      ║
 * ║                                                                           ║
 * ║ So this one builds the fixture, sits the exam in a real browser at real   ║
 * ║ phone sizes, and puts it back afterwards.                                 ║
 * ║                                                                           ║
 * ║ WHAT IT CANNOT TEST, AND DOES NOT PRETEND TO:                             ║
 * ║  · a real soft keyboard — headless Chrome has none, so "the keyboard does ║
 * ║    not cover the input" is untestable here                                ║
 * ║  · iOS Safari — no iOS on this machine; Chrome says nothing about it      ║
 * ║  · an actual screen lock — visibilitychange is simulated, not a lock      ║
 * ║  · whether Wake Lock physically holds the screen on — headless does not   ║
 * ║    grant it; the REQUEST is observable, the effect is not                 ║
 * ║                                                                           ║
 * ║ Those are reported as NOT TESTED. A green tick nobody earned is worse     ║
 * ║ than an honest gap.                                                       ║
 * ╚═══════════════════════════════════════════════════════════════════════════╝
 *
 *   npm run start          (production build; the service worker needs it)
 *   node scripts/check-exam-mobile.mjs
 * ═══════════════════════════════════════════════════════════════════════════
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import pg from 'pg'
import { claimFreePaper } from './free-paper.mjs'

const APP = process.env.APP_URL ?? 'http://localhost:3000'
const CHROME = process.env.CHROME_PATH ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PASSWORD = 'Sample-2026!'
const MIN_TARGET = 44

/** Real devices, not round numbers: a Pixel-ish, an iPhone, a large Android. */
const VIEWPORTS = [
  { w: 360, h: 800, name: '360x800 (small Android)' },
  { w: 390, h: 844, name: '390x844 (iPhone)' },
  { w: 412, h: 915, name: '412x915 (large Android)' },
]

const env = {}
for (const line of readFileSync(resolve('.env.local'), 'utf-8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/)
  if (m) env[m[1]] = m[2].trim()
}
const SUPABASE = env.NEXT_PUBLIC_SUPABASE_URL
const ANON = env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
const ref = new URL(SUPABASE).hostname.split('.')[0]

let fails = 0
const results = []
const check = (label, pass, detail = '') => {
  if (!pass) fails += 1
  results.push({ label, pass, detail })
  console.log(`  ${pass ? '✅' : '❌'} ${label}${detail ? ` — ${detail}` : ''}`)
}
const note = (label, detail) => {
  results.push({ label, skipped: true, detail })
  console.log(`  ⃝  ${label} — NOT TESTED: ${detail}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── Auth ────────────────────────────────────────────────────────────────────
async function signIn(email) {
  const s = await (
    await fetch(`${SUPABASE}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: ANON, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: PASSWORD }),
    })
  ).json()
  if (!s.access_token) throw new Error(`sign-in failed for ${email} — run \`npm run db:sample\``)

  const name = `sb-${ref}-auth-token`
  const encoded = 'base64-' + Buffer.from(JSON.stringify(s)).toString('base64url')
  const parts = []
  for (let i = 0; i < encoded.length; i += 3180) parts.push(encoded.slice(i, i + 3180))
  return { token: s.access_token, parts, name }
}

async function rpc(user, fn, args) {
  const res = await fetch(`${SUPABASE}/rest/v1/rpc/${fn}`, {
    method: 'POST',
    headers: {
      apikey: ANON,
      Authorization: `Bearer ${user.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args ?? {}),
  })
  const text = await res.text()
  let body
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = text
  }
  return res.ok ? { ok: true, data: body } : { ok: false, error: body, status: res.status }
}

// ── CDP ─────────────────────────────────────────────────────────────────────
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
    ws.addEventListener('error', () => rej(new Error('cannot reach Chrome')))
  })

  return {
    ready,
    // Bounded, always: an unbounded CDP call turns a hung page into a hung run.
    send(method, params = {}, timeoutMs = 20_000) {
      const msgId = ++id
      return new Promise((res, rej) => {
        const timer = setTimeout(() => {
          pending.delete(msgId)
          rej(new Error(`CDP timeout: ${method}`))
        }, timeoutMs)
        pending.set(msgId, {
          resolve: (v) => {
            clearTimeout(timer)
            res(v)
          },
          reject: (e) => {
            clearTimeout(timer)
            rej(e)
          },
        })
        ws.send(JSON.stringify({ id: msgId, method, params }))
      })
    },
  }
}

/** Evaluate and return the value, or throw with the page's own error. */
async function evaluate(page, expression) {
  const { result, exceptionDetails } = await page.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (exceptionDetails) throw new Error(exceptionDetails.text ?? 'page threw')
  return result?.value
}

/*
 * location.href rather than Page.navigate: under device emulation the latter's
 * reply is sometimes never delivered, which hangs the run on a CDP call that
 * looks exactly like a broken page. Readiness is polled instead.
 */
async function goto(page, url) {
  await page.send('Runtime.evaluate', { expression: `location.href = ${JSON.stringify(url)}` })
  for (let i = 0; i < 60; i++) {
    await sleep(250)
    try {
      const state = await evaluate(page, '[document.readyState, location.pathname].join("|")')
      if (typeof state === 'string' && state.startsWith('complete')) break
    } catch {
      /* mid-navigation; the context is being replaced. */
    }
  }
  await sleep(400)
}

/** The layout probe — the same rules check-mobile.mjs applies everywhere else. */
const LAYOUT_PROBE = `(() => {
  const doc = document.documentElement
  const overflow = Math.max(0, doc.scrollWidth - doc.clientWidth)

  const small = []
  const seen = new Set()
  for (const el of document.querySelectorAll('a, button, [role="button"], [role="radio"], input:not([type="hidden"]), select, textarea')) {
    const r = el.getBoundingClientRect()
    if (r.width === 0 || r.height === 0) continue
    const style = getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none') continue
    if (el.closest('[aria-hidden="true"]') || el.disabled) continue

    let box = r
    const role = el.getAttribute('role')
    const isChoice =
      el.type === 'radio' || el.type === 'checkbox' || role === 'radio' || role === 'checkbox'
    if (isChoice) {
      /*
       * A radio dot is 16px by design and always will be — enlarging it looks
       * broken. What has to be 44px is the LABEL wrapping it, which is what a
       * finger actually lands on. Base UI puts role="radio" on a span with no
       * .type, so matching on type alone measured the dot and failed a row
       * that is comfortably tappable.
       */
      const label = el.closest('label')
      if (label) {
        const lr = label.getBoundingClientRect()
        if (Math.min(lr.width, lr.height) >= ${MIN_TARGET} - 0.5) continue
        box = lr
      }
    }
    const name = (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().replace(/\\s+/g,' ').slice(0,40)
    if (Math.min(box.width, box.height) < ${MIN_TARGET} - 0.5) {
      const key = name + Math.round(box.width) + 'x' + Math.round(box.height)
      if (!seen.has(key)) { seen.add(key); small.push(name + ' ' + Math.round(box.width) + 'x' + Math.round(box.height)) }
    }
  }

  const timer = document.querySelector('[role="timer"]')
  const nav = document.querySelector('nav[aria-label]')

  return JSON.stringify({
    overflow,
    small: small.slice(0, 5),
    timerText: timer ? timer.textContent.trim() : null,
    timerVisible: timer ? timer.getBoundingClientRect().top >= 0 && timer.getBoundingClientRect().bottom <= innerHeight : false,
    hasNav: !!nav,
    // The shell must not be here: Exam Mode is its own route group.
    hasAppNav: !!document.querySelector('nav[aria-label="Main"]'),
    bodyLen: document.body.innerHTML.length,
  })
})()`

/** Click the first control whose visible text matches. */
const clickByText = (label) => `(() => {
  const t = (el) => (el.textContent || '').replace(/\\s+/g, ' ').trim()
  for (const el of document.querySelectorAll('button, a')) {
    if (t(el) !== ${JSON.stringify(label)}) continue
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') return 'disabled'
    el.click()
    return 'clicked'
  }
  return 'missing'
})()`

/** Choose the Nth answer option on the current question. */
const pickOption = (n) => `(() => {
  const radios = [...document.querySelectorAll('[role="radio"]')]
  if (radios.length <= ${n}) return 'missing:' + radios.length
  radios[${n}].click()
  return 'picked'
})()`

const selectedIndex = `(() => {
  const radios = [...document.querySelectorAll('[role="radio"]')]
  return radios.findIndex((r) => r.getAttribute('aria-checked') === 'true' || r.checked)
})()`

const saveIndicator = `(() => {
  const states = ['Saving', 'Saved on this device', 'Saved', 'Not saved']
  const nodes = [...document.querySelectorAll('[role="status"]')]
  const hit = nodes.find((el) => states.some((s) => (el.textContent || '').trim().startsWith(s)))
  return hit ? hit.textContent.trim() : (nodes[0] ? nodes[0].textContent.trim() : null)
})()`

// ── Fixture ─────────────────────────────────────────────────────────────────
const db = new pg.Client({
  host: process.env.SUPABASE_DB_HOST ?? 'aws-0-ap-southeast-1.pooler.supabase.com',
  port: 5432,
  user: `postgres.${ref}`,
  password: env.SUPABASE_DB_PASSWORD,
  database: 'postgres',
  ssl: { rejectUnauthorized: false },
})

let chrome = null
const profile = mkdtempSync(resolve(tmpdir(), 'exam-'))
let examId = null
let attemptId = null
let paperWas = null
let paperId = null

try {
  const alive = await fetch(`${APP}/en/login`, { redirect: 'manual' })
    .then((r) => r.ok)
    .catch(() => false)
  if (!alive) {
    console.error(`\n  No server at ${APP}. Run \`npm run start\` first.\n`)
    process.exit(1)
  }

  await db.connect()

  console.log('\n  Building a live attempt…')

  const chef = await signIn('sample-chef@example.com')
  const employee = await signIn('sample-employee@example.com')

  /*
   * A paper is BORROWED, never created: generating one burns a combination
   * from a finite pool that the never-twice index depends on. Its status
   * triple is snapshotted and restored in `finally`.
   */
  const paper = await claimFreePaper(db)
  paperId = paper.id
  paperWas = {
    status: paper.status,
    at: paper.status_changed_at,
    by: paper.status_changed_by,
  }

  const published = await rpc(chef, 'publish_paper_as_exam', {
    p_paper_id: paperId,
    p_title: `Mobile exam check ${Date.now()}`,
    p_duration_minutes: 45,
    p_opens_at: null,
    p_closes_at: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
    p_max_attempts: 1,
    p_pass_mark_percent: 60,
    p_instructions: null,
    p_results_release: 'immediate',
  })
  if (!published.ok) throw new Error(`publish failed: ${JSON.stringify(published.error)}`)
  examId = published.data.examId ?? published.data?.exam_id
  if (!examId) throw new Error(`no exam id in ${JSON.stringify(published.data)}`)

  // The candidate's outlet, so the exam is actually assigned to them.
  const { rows: who } = await db.query(
    `select p.outlet_id from public.profiles p
       join auth.users u on u.id = p.id
      where u.email = 'sample-employee@example.com'`,
  )
  const outlet = who[0]?.outlet_id
  await db.query(
    `insert into public.exam_assignments (exam_id, target_kind, target_id)
     values ($1, $2, $3)`,
    outlet ? [examId, 'outlet', outlet] : [examId, 'company', '00000000-0000-0000-0000-00000000c001'],
  )

  const started = await rpc(employee, 'start_attempt', { p_exam_id: examId })
  if (!started.ok) throw new Error(`start_attempt failed: ${JSON.stringify(started.error)}`)
  attemptId = started.data[0].attempt_id
  const questionCount = started.data[0].question_count

  console.log(`  Attempt ${attemptId} · ${questionCount} questions\n`)

  // ── Browser ───────────────────────────────────────────────────────────────
  const port = 9353
  chrome = spawn(
    CHROME,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
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

  for (const [i, value] of employee.parts.entries()) {
    await page.send('Network.setCookie', {
      name: employee.parts.length === 1 ? employee.name : `${employee.name}.${i}`,
      value,
      domain: new URL(APP).hostname,
      path: '/',
    })
  }

  const examUrl = (locale = 'en') => `${APP}/${locale}/attempt/${attemptId}`

  // ── 1. Layout at each viewport ────────────────────────────────────────────
  console.log('── Layout ──────────────────────────────────────────────')
  for (const vp of VIEWPORTS) {
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: vp.w,
      height: vp.h,
      deviceScaleFactor: 2,
      mobile: true,
    })
    await goto(page, examUrl())

    const probe = JSON.parse(await evaluate(page, LAYOUT_PROBE))

    check(`${vp.name} — no horizontal overflow`, probe.overflow === 0, probe.overflow ? `${probe.overflow}px` : '')
    check(`${vp.name} — every target ≥ ${MIN_TARGET}px`, probe.small.length === 0, probe.small.join(', '))
    check(`${vp.name} — timer visible on screen`, probe.timerVisible, probe.timerText ?? 'no timer')
    check(`${vp.name} — question navigator present`, probe.hasNav)
    check(`${vp.name} — app navigation is NOT rendered (Exam Mode)`, !probe.hasAppNav)
  }

  // ── 2. The full flow ──────────────────────────────────────────────────────
  console.log('\n── Exam flow ───────────────────────────────────────────')
  await page.send('Emulation.setDeviceMetricsOverride', {
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  })
  await goto(page, examUrl())

  check('Q1 — an option can be selected', (await evaluate(page, pickOption(1))) === 'picked')
  await sleep(1400) // past the 800ms debounce, plus the round trip
  const afterFirst = await evaluate(page, saveIndicator)
  check('Q1 — the save reaches the server', afterFirst === 'Saved', String(afterFirst))

  check('navigate to Q2', (await evaluate(page, clickByText('Next'))) === 'clicked')
  await sleep(600)
  check('Q2 — an option can be selected', (await evaluate(page, pickOption(2))) === 'picked')
  await sleep(1400)

  check('navigate back to Q1', (await evaluate(page, clickByText('Previous'))) === 'clicked')
  await sleep(600)
  check('Q1 — the answer survived navigation', (await evaluate(page, selectedIndex)) === 1, `index ${await evaluate(page, selectedIndex)}`)

  check('navigate forward to Q2', (await evaluate(page, clickByText('Next'))) === 'clicked')
  await sleep(600)
  check('Q2 — the answer survived navigation', (await evaluate(page, selectedIndex)) === 2, `index ${await evaluate(page, selectedIndex)}`)

  // ── 3. Offline ────────────────────────────────────────────────────────────
  console.log('\n── Offline ─────────────────────────────────────────────')
  await page.send('Network.emulateNetworkConditions', {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
  })

  await evaluate(page, clickByText('Next'))
  await sleep(600)
  const offlinePicked = await evaluate(page, pickOption(0))
  check('an answer can still be chosen with no network', offlinePicked === 'picked')
  await sleep(2000)

  const offlineState = await evaluate(page, saveIndicator)
  check(
    'it says "Saved on this device" — not "Saved"',
    offlineState === 'Saved on this device',
    String(offlineState),
  )

  // It must survive moving between questions while still offline.
  await evaluate(page, clickByText('Previous'))
  await sleep(500)
  await evaluate(page, clickByText('Next'))
  await sleep(500)
  check('the offline answer survives navigation', (await evaluate(page, selectedIndex)) === 0)

  // Backgrounding, simulated.
  await evaluate(
    page,
    `document.dispatchEvent(new Event('visibilitychange')); 'ok'`,
  )
  await sleep(400)
  check('the offline answer survives backgrounding', (await evaluate(page, selectedIndex)) === 0)
  check('the exam did not auto-submit', (await evaluate(page, `!!document.querySelector('[role="timer"]')`)) === true)

  // ── 4. Reconnect ──────────────────────────────────────────────────────────
  console.log('\n── Reconnect ───────────────────────────────────────────')
  await page.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
  })
  await evaluate(page, `window.dispatchEvent(new Event('online')); 'ok'`)

  let synced = null
  for (let i = 0; i < 20; i++) {
    await sleep(750)
    synced = await evaluate(page, saveIndicator)
    if (synced === 'Saved') break
  }
  check('it reaches "Saved" once the network returns', synced === 'Saved', String(synced))

  // The database is the judge, not the indicator.
  const { rows: stored } = await db.query(
    `select count(*)::int n from public.attempt_answers where attempt_id = $1`,
    [attemptId],
  )
  check('the server actually holds the answers', stored[0].n >= 3, `${stored[0].n} stored`)

  // ── 5. Exit guard ─────────────────────────────────────────────────────────
  console.log('\n── Exit guard ──────────────────────────────────────────')
  await evaluate(page, `history.back(); 'ok'`)
  await sleep(900)
  const dialog = await evaluate(
    page,
    `(() => { const el = document.querySelector('[role="alertdialog"], [role="dialog"]'); return el ? el.textContent.trim().slice(0, 60) : null })()`,
  )
  check('back raises a confirmation instead of leaving', dialog !== null, String(dialog))
  check('still on the exam', (await evaluate(page, 'location.pathname')).includes(attemptId))

  const { rows: notSubmitted } = await db.query(
    `select status from public.attempts where id = $1`,
    [attemptId],
  )
  check(
    'leaving did NOT submit the exam',
    notSubmitted[0].status === 'in_progress',
    notSubmitted[0].status,
  )

  await evaluate(page, clickByText('Stay in exam'))
  await sleep(400)

  // ── 6. Languages ──────────────────────────────────────────────────────────
  console.log('\n── Hindi and Gujarati ──────────────────────────────────')
  for (const [locale, range, label] of [
    ['hi', '\\u0900-\\u097F', 'Hindi'],
    ['gu', '\\u0A80-\\u0AFF', 'Gujarati'],
  ]) {
    await goto(page, examUrl(locale))
    const probe = JSON.parse(await evaluate(page, LAYOUT_PROBE))
    check(`${label} — no horizontal overflow`, probe.overflow === 0, probe.overflow ? `${probe.overflow}px` : '')

    const script = await evaluate(
      page,
      `new RegExp('[${range}]').test(document.body.textContent) ? 'present' : 'absent'`,
    )
    check(`${label} — the script actually renders`, script === 'present')

    /*
     * A line beginning with a combining mark is the signature of a broken
     * break in Indic text — the same class of bug the PDF renderer had.
     */
    const orphan = await evaluate(
      page,
      `(() => {
        const bad = /^[\\u0900-\\u0903\\u093A-\\u094F\\u0951-\\u0957\\u0962\\u0963\\u0A81-\\u0A83\\u0ABE-\\u0ACF]/
        for (const el of document.querySelectorAll('p, span, label, h1, h2, li')) {
          for (const line of (el.textContent || '').split('\\n')) {
            const t = line.trim()
            if (t && bad.test(t)) return t.slice(0, 30)
          }
        }
        return null
      })()`,
    )
    check(`${label} — no line starts with a combining mark`, orphan === null, String(orphan))
  }

  // ── 7. Navigator, submit dialog, and the answer key ───────────────────────
  console.log('\n── Navigator and submit ────────────────────────────────')
  await goto(page, examUrl())

  const navStates = await evaluate(
    page,
    `(() => {
      const nav = document.querySelector('nav[aria-label]')
      if (!nav) return null
      const labels = [...nav.querySelectorAll('button, a')].map((b) => b.getAttribute('aria-label') || '')
      return JSON.stringify({
        answered: labels.filter((l) => /answered/i.test(l) && !/not answered/i.test(l)).length,
        unanswered: labels.filter((l) => /not answered/i.test(l)).length,
        current: labels.filter((l) => /current/i.test(l)).length,
      })
    })()`,
  )
  const nav = navStates ? JSON.parse(navStates) : null
  check(
    'the navigator distinguishes answered / unanswered / current',
    Boolean(nav && nav.answered > 0 && nav.unanswered > 0 && nav.current === 1),
    navStates ?? 'no navigator',
  )

  const leaked = await evaluate(
    page,
    `/"correct"|answer_key|model_answer|"rubric"/.test(document.documentElement.innerHTML) ? 'LEAKED' : 'clean'`,
  )
  check('no answer key anywhere in the page', leaked === 'clean', String(leaked))

  // Walk to the last question so Submit is offered.
  for (let i = 0; i < questionCount + 2; i++) {
    const r = await evaluate(page, clickByText('Next'))
    if (r !== 'clicked') break
    await sleep(90)
  }
  const opened = await evaluate(page, clickByText('Submit exam'))
  check('the submit button is reachable', opened === 'clicked', String(opened))
  await sleep(700)

  const dialogText = await evaluate(
    page,
    `(() => { const el = document.querySelector('[role="alertdialog"], [role="dialog"]'); return el ? el.textContent.replace(/\\s+/g,' ').trim() : null })()`,
  )
  check('the submit dialog names the unanswered count', /unanswered/i.test(String(dialogText)), String(dialogText).slice(0, 90))

  /*
   * Scoped to the dialog. The trigger and the confirm button carry the SAME
   * label, so an unscoped match re-clicks the trigger and the exam is never
   * submitted — which reads as a product bug and is not one.
   */
  const confirmed = await evaluate(
    page,
    `(() => {
      const dlg = document.querySelector('[role="alertdialog"], [role="dialog"]')
      if (!dlg) return 'no-dialog'
      const t = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim()
      for (const el of dlg.querySelectorAll('button')) {
        if (/^Submit/i.test(t(el))) { el.click(); return 'clicked' }
      }
      return 'no-button:' + [...dlg.querySelectorAll('button')].map(t).join('|')
    })()`,
  )
  check('submitting works', confirmed === 'clicked', String(confirmed))
  await sleep(2500)

  const { rows: after } = await db.query(`select status from public.attempts where id = $1`, [
    attemptId,
  ])
  check('the attempt is closed server-side', after[0].status !== 'in_progress', after[0].status)

  // ── What cannot be tested here ────────────────────────────────────────────
  console.log('\n── Not testable in this environment ────────────────────')
  note('Android / iOS soft keyboard', 'headless Chrome raises no keyboard')
  note('iOS Safari fullscreen and Wake Lock', 'no iOS available; Chrome implies nothing about Safari')
  note('a real screen lock', 'visibilitychange is simulated, not a device lock')
  note('Wake Lock physically holding the screen on', 'headless Chrome does not grant the lock; only the request is observable')
  note('real touch input', 'targets are measured geometrically, which is what the 44px rule is')
} catch (err) {
  fails += 1
  console.error(`\n  ✖ ${err.message}\n`)
} finally {
  if (chrome) chrome.kill()
  try {
    rmSync(profile, { recursive: true, force: true })
  } catch {
    /* Windows holds the profile briefly. */
  }

  // ── Put everything back ───────────────────────────────────────────────────
  try {
    if (attemptId) {
      await db.query('delete from public.attempt_answers where attempt_id = $1', [attemptId])
      await db.query('delete from public.attempt_questions where attempt_id = $1', [attemptId])
      await db.query('delete from public.attempts where id = $1', [attemptId])
    }
    if (examId) {
      await db.query('delete from public.exam_assignments where exam_id = $1', [examId])
      await db.query('delete from public.exams where id = $1', [examId])
    }
    if (paperId && paperWas) {
      // All three, not just status: restoring one silently erases the
      // provenance of a paper this script does not own.
      await db.query(
        `update public.exam_papers
            set status = $2, status_changed_at = $3, status_changed_by = $4
          where id = $1`,
        [paperId, paperWas.status, paperWas.at, paperWas.by],
      )
    }
    console.log('\n  🧹 attempt, exam and assignment removed; paper restored')
  } catch (err) {
    console.error(`  cleanup problem: ${err.message}`)
  }

  await db.end().catch(() => {})
}

const passed = results.filter((r) => r.pass).length
const skipped = results.filter((r) => r.skipped).length
console.log(`\n  ${fails === 0 ? 'PASS' : 'FAIL'} — ${passed} checked, ${fails} failed, ${skipped} not testable here\n`)
process.exitCode = fails === 0 ? 0 : 1
